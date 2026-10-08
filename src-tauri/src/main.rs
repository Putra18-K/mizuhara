// Mizuhara runs without a console window: Mizuhara is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mizuhara_lib::run()
}
