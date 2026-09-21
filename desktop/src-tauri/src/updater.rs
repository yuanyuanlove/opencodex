use crate::{exit::RestartReadiness, logging, tray};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct PendingUpdate(pub Mutex<Option<Update>>);

pub async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    app.updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

pub async fn install(app: &AppHandle, update: Update) -> Result<(), String> {
    // Download and verify first, and separately from installing. The pinned updater checks the
    // release signature inside `download`, so these bytes are the ones the key signed; nothing has
    // been replaced yet, and a failure here costs only the download.
    let package = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;

    // Then stop the runtime, and confirm it stopped, *before* anything is replaced. Asking for the
    // restart after `install` is the shape that does not work: the pinned Windows installer hands off
    // to the installer process and ends this one, so the call after it is never reached and the
    // update would replace files under a runtime that is still serving. R2 still holds — this is a
    // coordinated restart and not a quit — but the coordination has to finish first.
    let readiness = crate::exit::prepare_restart(app).await;
    if readiness != RestartReadiness::Ready {
        return Err(format!(
            "the update was downloaded but not installed: {}",
            readiness.describe()
        ));
    }

    update.install(package).map_err(|error| error.to_string())?;
    // Only reached where the installer returns. On Windows it does not.
    crate::exit::complete_restart(app)
}

pub fn update_label(version: &str) -> String {
    format!("Install update v{version}")
}

pub fn start_background_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            check_and_show(&app).await;
            tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

pub async fn check_and_show(app: &AppHandle) {
    if tray::is_installing(app) {
        return;
    }
    match check(app).await {
        Ok(Some(update)) => {
            if tray::is_installing(app) {
                return;
            }
            let version = update.version.clone();
            if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                *pending = Some(update);
            }
            tray::show_update_available(app, &version);
        }
        Ok(None) => {
            if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                *pending = None;
            }
            tray::show_up_to_date(app);
        }
        Err(error) => logging::log_once("updater check failed", &error),
    }
}

#[cfg(test)]
mod tests {
    use super::update_label;

    #[test]
    fn formats_update_menu_label() {
        assert_eq!(update_label("2.62.0"), "Install update v2.62.0");
    }
}
