use crate::{auth::Auth, exit, AppState};
use tauri::{AppHandle, Manager, Url, WebviewWindow, WindowEvent};

pub fn webview_user_agent() -> String {
    let platform = if cfg!(target_os = "macos") {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    } else if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    } else {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)"
    };
    format!("{platform} {}", Auth::user_agent())
}

/// Decide what closing this window means, at the moment it is closed.
///
/// The answer is not known when the window is built: on Linux it depends on a session-bus probe
/// that the startup sequence runs afterwards. So it is read here rather than captured. With a tray
/// a close hides and the runtime keeps serving; without one there is nowhere to hide, so D6 makes
/// the close a quit — and it takes the same graceful drain the tray's Quit does.
pub fn configure(window: &WebviewWindow) {
    let window_for_close = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            exit::gesture(window_for_close.app_handle());
        }
    });
}

/// Where this window may navigate.
///
/// The loopback endpoint is read from the app rather than captured, because the window now exists
/// before anything has been resolved. Until it has, an http target is refused outright instead of
/// being handed to the browser: nothing should be navigating anywhere yet, and opening an
/// unresolved address in the user's browser is a worse answer than doing nothing.
pub fn navigation_allowed(app: AppHandle) -> impl Fn(&Url) -> bool {
    move |url| {
        if url.scheme() == "tauri" {
            return true;
        }
        if app_origin_allowed(url, cfg!(target_os = "windows")) {
            return true;
        }
        if url.scheme() == "about" && url.as_str() == "about:blank" {
            return true;
        }
        let endpoint = app
            .try_state::<AppState>()
            .and_then(|state| state.proxy())
            .map(|proxy| proxy.endpoint());
        if let Some(endpoint) = endpoint {
            if url.scheme() == "http" && url.host_str() == Some(endpoint.host) {
                return url.port_or_known_default() == Some(endpoint.port);
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
        }
        false
    }
}

/// Whether this URL is the app's own page on a platform that serves it over http.
///
/// The pinned Tauri serves the app from `tauri://localhost` everywhere except Windows and Android,
/// where wry needs a http origin and it uses `tauri.localhost` instead. Without this the window's
/// first navigation to its own page on Windows falls through to the branch that hands a URL to the
/// external browser.
///
/// It is that one host, with no port: not localhost generally, which would admit anything any local
/// process chose to serve, and not a widening of what the loopback dashboard may reach.
pub fn app_origin_allowed(url: &Url, windows: bool) -> bool {
    windows
        && matches!(url.scheme(), "http" | "https")
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none()
}

pub fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    apply_tray_policy(window.app_handle(), true);
}

pub fn hide(window: &WebviewWindow) {
    let _ = window.hide();
    apply_tray_policy(window.app_handle(), false);
}

#[cfg(target_os = "macos")]
fn apply_tray_policy(app: &AppHandle, visible: bool) {
    let policy = if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    let _ = app.set_dock_visibility(visible);
    let _ = app.set_activation_policy(policy);
}

#[cfg(not(target_os = "macos"))]
fn apply_tray_policy(_app: &AppHandle, _visible: bool) {}

pub fn set_tray_policy(app: &AppHandle, visible: bool) {
    apply_tray_policy(app, visible);
}

#[cfg(test)]
mod tests {
    use super::{app_origin_allowed, webview_user_agent};
    use tauri::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("a url")
    }

    #[test]
    fn the_windows_app_origin_is_allowed_where_it_is_used() {
        assert!(app_origin_allowed(
            &url("http://tauri.localhost/index.html"),
            true
        ));
        assert!(app_origin_allowed(&url("https://tauri.localhost/"), true));
        // Nowhere else: on the platforms that use the tauri scheme this host is just a name a
        // local process could claim.
        assert!(!app_origin_allowed(&url("http://tauri.localhost/"), false));
    }

    #[test]
    fn it_does_not_widen_to_localhost_or_to_a_port() {
        for value in [
            "http://localhost/",
            "http://127.0.0.1/",
            "http://evil.tauri.localhost/",
            "http://tauri.localhost.example.com/",
            "http://tauri.localhost:8080/",
        ] {
            assert!(!app_origin_allowed(&url(value), true), "{value}");
        }
    }

    #[test]
    fn webview_user_agent_marks_the_desktop_shell() {
        let user_agent = webview_user_agent();
        assert!(user_agent.starts_with("Mozilla/5.0 "));
        assert!(user_agent.contains("OpenCodexDesktop/"));
        if cfg!(target_os = "macos") {
            assert!(user_agent.contains("(Macintosh; Intel Mac OS X 10_15_7)"));
        } else if cfg!(target_os = "windows") {
            assert!(user_agent.contains("(Windows NT 10.0; Win64; x64)"));
        } else {
            assert!(user_agent.contains("(X11; Linux x86_64)"));
        }
    }
}
