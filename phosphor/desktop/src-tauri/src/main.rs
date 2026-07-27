// Prevents an additional console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// The resolved URL of the bundled settings page (`index.html`), captured
/// once at startup while the main window is still showing it. We stash it
/// as managed state so that "back to settings" (menu item / accelerator)
/// can navigate the window back to it later without having to guess which
/// internal scheme (`tauri://localhost`, `http://tauri.localhost`, ...)
/// the current platform's webview happens to use for bundled assets.
struct SettingsUrl(Url);

/// Invoked from the settings page's JS after the user submits the "Phosphor
/// App URL" form (or automatically on startup if a URL was already saved to
/// localStorage). Navigates the single app window to that external URL,
/// which is the entire point of this wrapper: it doesn't render any of the
/// real UI itself, it just points the webview at the user's self-hosted
/// Phosphor web app.
#[tauri::command]
fn connect(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let parsed = Url::parse(trimmed).map_err(|err| format!("Invalid URL: {err}"))?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("The Phosphor App URL must start with http:// or https://".into());
    }

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    window.navigate(parsed).map_err(|err| err.to_string())
}

/// Navigates the main window back to the bundled settings page. Shared by
/// the native "Settings..." menu item / accelerator.
fn show_settings(app: &AppHandle) {
    let Some(settings_url) = app.try_state::<SettingsUrl>() else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.navigate(settings_url.0.clone());
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect])
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("PHOSPHOR")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .on_navigation(|url| {
                    // This wrapper's entire job is to let the window leave the
                    // bundled settings page and load whatever self-hosted
                    // Phosphor web app URL the user configured (LAN IP,
                    // custom domain, non-standard port, reverse proxy path,
                    // etc). We therefore allow navigation to any http/https
                    // destination rather than pinning it to a fixed
                    // allowlist. `tauri` is included too since that (or an
                    // equivalent internal scheme) is how the bundled
                    // settings page itself is served on some platforms.
                    matches!(url.scheme(), "http" | "https" | "tauri")
                })
                .build()?;

            // Remember where the settings page actually resolved to so we
            // can return to it later. Must be read before anything
            // navigates the window away from it.
            if let Ok(initial_url) = window.url() {
                app.manage(SettingsUrl(initial_url));
            }

            let settings_item = MenuItemBuilder::new("Settings...")
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Phosphor")
                .item(&settings_item)
                .separator()
                .item(&PredefinedMenuItem::quit(app, Some("Quit"))?)
                .build()?;

            let menu = MenuBuilder::new(app).items(&[&app_menu]).build()?;
            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                if event.id().0.as_str() == "settings" {
                    show_settings(app_handle);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
