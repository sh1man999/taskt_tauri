// -----------------------------------------------------------------------------
// 2. Бэкенд на Rust (src-tauri/src/main.rs)
// -----------------------------------------------------------------------------
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, PhysicalPosition, PhysicalSize, Monitor, Window};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
use std::sync::Mutex;
use once_cell::sync::Lazy;
use std::time::{Instant};
use serde::{Serialize, Deserialize};
use dashmap::DashMap; // Для потокобезопасного HashMap
// Для tauri-plugin-store, если нужно будет взаимодействовать из Rust (обычно управляется из JS)
// use tauri_plugin_store::{StoreBuilder, StoreCollection, with_store};
use uuid::Uuid;
use image;


// --- Структуры данных для задач ---
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct Task {
    id: String,
    content: String,
    time_spent_ms: u64,
}

// --- Глобальное состояние (в памяти Rust) ---
// TASKS_DB будет отражать состояние задач, с которыми активно работает таймер.
// Основное хранилище будет в tauri-plugin-store, управляемом из фронтенда.
static TASKS_DB: Lazy<DashMap<String, Task>> = Lazy::new(DashMap::new);
static ACTIVE_TASK_ID: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static TIMER_START_INSTANT: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));

const COLLAPSED_WIDTH: f64 = 250.0;
const COLLAPSED_HEIGHT: f64 = 100.0;
const EXPANDED_WIDTH: f64 = 900.0;
const EXPANDED_HEIGHT: f64 = 600.0;
const SCREEN_PADDING: f64 = 20.0; // Отступ от края экрана

// --- Команды Tauri ---

#[tauri::command]
async fn initialize_window_state(window: tauri::WebviewWindow) -> Result<(), String> {
    set_window_bottom_right(&window, COLLAPSED_WIDTH, COLLAPSED_HEIGHT).await?;
    Ok(())
}

async fn set_window_bottom_right(window: &tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let monitor: Option<Monitor> = window.current_monitor().map_err(|e| e.to_string())?;
    if let Some(monitor) = monitor {
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();

        let new_physical_size = PhysicalSize::new(width * scale_factor, height * scale_factor);
        let new_x = monitor_size.width as f64 - (width * scale_factor) - (SCREEN_PADDING * scale_factor);
        let new_y = monitor_size.height as f64 - (height * scale_factor) - (SCREEN_PADDING * scale_factor);
        let new_physical_position = PhysicalPosition::new(new_x, new_y);

        window.set_size(new_physical_size).map_err(|e| e.to_string())?;
        window.set_position(new_physical_position).map_err(|e| e.to_string())?;
    } else {
        return Err("Не удалось получить информацию о текущем мониторе.".into());
    }
    Ok(())
}


#[tauri::command]
async fn toggle_expansion(window: tauri::WebviewWindow, expanded: bool) -> Result<(), String> {
    if expanded {
        set_window_bottom_right(&window, EXPANDED_WIDTH, EXPANDED_HEIGHT).await?;
    } else {
        set_window_bottom_right(&window, COLLAPSED_WIDTH, COLLAPSED_HEIGHT).await?;
    }
    Ok(())
}

// Внутренняя функция для остановки таймера и обновления TASKS_DB
fn stop_timer_internal() -> Result<Option<Task>, String> {
    let mut active_task_guard = ACTIVE_TASK_ID.lock().map_err(|e| e.to_string())?;
    let mut timer_start_guard = TIMER_START_INSTANT.lock().map_err(|e| e.to_string())?;

    if let (Some(task_id_val), Some(start_time)) = (&*active_task_guard, &*timer_start_guard) {
        let task_id_val_cloned = task_id_val.clone();
        let elapsed_ms = start_time.elapsed().as_millis() as u64;
        let updated_task: Option<Task>;
        if let Some(mut task_entry) = TASKS_DB.get_mut(&task_id_val_cloned) {
            task_entry.time_spent_ms += elapsed_ms;
            updated_task = Some(task_entry.clone());
            println!("Задача {} обновлена в TASKS_DB, добавлено {} мс. Всего: {} мс", task_id_val_cloned, elapsed_ms, task_entry.time_spent_ms);
        } else {
            // Этого не должно произойти, если логика корректна
            eprintln!("Ошибка: Активная задача {} не найдена в TASKS_DB при остановке таймера.", task_id_val_cloned);
            updated_task = None;
        }
        
        *active_task_guard = None;
        *timer_start_guard = None;
        println!("Таймер остановлен для задачи (внутренне): {}", task_id_val_cloned);
        Ok(updated_task)
    } else {
        Ok(None) // Таймер не был активен
    }
}

#[tauri::command]
fn start_timer(task_to_start: Task) -> Result<Task, String> {
    // Сначала остановим текущий таймер, если он есть
    let _ = stop_timer_internal()?; // Результат остановки предыдущей задачи нам здесь не так важен

    let mut active_task_guard = ACTIVE_TASK_ID.lock().map_err(|e| e.to_string())?;
    let mut timer_start_guard = TIMER_START_INSTANT.lock().map_err(|e| e.to_string())?;

    // Обновляем или вставляем задачу в TASKS_DB
    // Это важно, так как task_to_start может содержать time_spent_ms из store
    TASKS_DB.insert(task_to_start.id.clone(), task_to_start.clone());

    *active_task_guard = Some(task_to_start.id.clone());
    *timer_start_guard = Some(Instant::now());
    println!("Таймер запущен для задачи: {} (из TASKS_DB)", task_to_start.id);
    Ok(task_to_start) // Возвращаем задачу, для которой запущен таймер
}


#[tauri::command]
fn pause_timer() -> Result<Option<Task>, String> {
    println!("Команда pause_timer вызвана.");
    stop_timer_internal() // Останавливаем и возвращаем обновленную задачу
}


#[tauri::command]
fn get_current_task_time() -> Result<Option<(String, u64)>, String> {
    let active_task_guard = ACTIVE_TASK_ID.lock().map_err(|e| e.to_string())?;
    let timer_start_guard = TIMER_START_INSTANT.lock().map_err(|e| e.to_string())?;

    if let (Some(task_id), Some(start_time)) = (&*active_task_guard, &*timer_start_guard) {
        // Таймер активен, вычисляем текущее время
        if let Some(task_from_db) = TASKS_DB.get(task_id) {
            let current_segment_elapsed = start_time.elapsed().as_millis() as u64;
            Ok(Some((task_id.clone(), task_from_db.time_spent_ms + current_segment_elapsed)))
        } else {
            // Не должно случиться, если задача была корректно добавлена в TASKS_DB при start_timer
            eprintln!("Ошибка: Активная задача {} не найдена в TASKS_DB при get_current_task_time.", task_id);
            Ok(None)
        }
    } else if let Some(task_id) = &*active_task_guard {
        // Таймер не запущен (на паузе), но задача выбрана. Берем время из TASKS_DB.
         if let Some(task_from_db) = TASKS_DB.get(task_id) {
            Ok(Some((task_id.clone(), task_from_db.time_spent_ms)))
        } else {
            eprintln!("Ошибка: Выбранная (но на паузе) задача {} не найдена в TASKS_DB.", task_id);
            Ok(None)
        }
    }
    else {
        Ok(None) // Нет активной или выбранной задачи
    }
}

#[tauri::command]
fn create_task_in_rust_db(content: String) -> Result<Task, String> {
    // Эта команда создает задачу только в Rust TASKS_DB.
    // Фронтенд будет отвечать за создание в store и затем синхронизацию с TASKS_DB при необходимости.
    let id = Uuid::new_v4().to_string();
    let new_task = Task {
        id: id.clone(),
        content,
        time_spent_ms: 0,
    };
    TASKS_DB.insert(id.clone(), new_task.clone());
    println!("Создана задача в Rust TASKS_DB: {:?}", new_task);
    Ok(new_task)
}

#[tauri::command]
fn get_all_tasks_from_rust_db() -> Result<Vec<Task>, String> {
    // Эта команда получает задачи из Rust TASKS_DB.
    // Фронтенд будет в основном читать из store.
    Ok(TASKS_DB.iter().map(|entry| entry.value().clone()).collect())
}

// Команда для синхронизации TASKS_DB с состоянием из store (вызывается фронтендом при необходимости)
#[tauri::command]
fn sync_task_to_rust_db(task: Task) -> Result<(), String> {
    println!("Синхронизация задачи {:?} с Rust TASKS_DB", task);
    TASKS_DB.insert(task.id.clone(), task);
    Ok(())
}

#[tauri::command]
async fn hide_window_to_tray(window: Window) -> Result<(), String> {
    match window.hide() {
        Ok(_) => {
            println!("Window hidden to tray");
            Ok(())
        }
        Err(e) => {
            eprintln!("Failed to hide window: {}", e);
            Err(format!("Failed to hide window: {}", e))
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let main_window = app.get_webview_window("main").unwrap();
            let window_clone = main_window.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = initialize_window_state(window_clone).await {
                    eprintln!("Ошибка инициализации положения окна: {}", e);
                }
            });

            let app_handle = app.handle().clone();

            let show_app_item = MenuItem::with_id(&app_handle, "show_app", "Открыть", true, None::<String>).unwrap();
            let quit_app_item = MenuItem::with_id(&app_handle, "quit_app", "Выход", true, None::<String>).unwrap();
            
            let tray_menu = Menu::with_items(&app_handle, &[
                &show_app_item,
                &PredefinedMenuItem::separator(&app_handle).unwrap(),
                &quit_app_item,
            ]).unwrap();

            let icon_bytes = include_bytes!("../icons/icon.ico").to_vec();
            let decoded_image = image::load_from_memory_with_format(&icon_bytes, image::ImageFormat::Ico)
                .expect("Failed to decode ICO from memory");
            let rgba_image = decoded_image.to_rgba8();
            let (width, height) = rgba_image.dimensions();
            let raw_rgba_vec = rgba_image.into_raw(); // Get Vec<u8>
            let tray_icon_data = tauri::image::Image::new(
                &raw_rgba_vec, // Pass as slice
                width,
                height,
            ); // Removed .expect, as ::new is const and doesn't return Result

            TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("Taskt")
                .icon(tray_icon_data)
                .on_menu_event(move |app_h, event| {
                    match event.id.as_ref() {
                        "show_app" => {
                            if let Some(window) = app_h.get_webview_window("main") {
                                window.show().expect("Failed to show window");
                                window.set_focus().expect("Failed to focus window");
                            }
                        }
                        "quit_app" => {
                            app_h.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray_handler, event| {
                    let app_h = tray_handler.app_handle(); 
                    match event { 
                        TrayIconEvent::Click { button, .. } if button == MouseButton::Left => {
                            if let Some(window) = app_h.get_webview_window("main") {
                                if !window.is_visible().unwrap_or(false) {
                                    window.show().expect("Failed to show window");
                                }
                                window.set_focus().expect("Failed to focus window");
                            }
                        }
                        _ => {} 
                    }
                })
                .build(app.handle())
                .expect("Failed to build tray icon");
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_window_state,
            toggle_expansion,
            start_timer,
            pause_timer,
            get_current_task_time,
            create_task_in_rust_db,
            get_all_tasks_from_rust_db,
            sync_task_to_rust_db,
            hide_window_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("Ошибка при запуске Tauri приложения");
}