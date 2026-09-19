use std::collections::BTreeMap;
use zellij_tile::prelude::*;

const MAX_LINES: usize = 100_000;
const MAX_ACTIONS: usize = 256;
#[derive(Default)]
struct State;
register_plugin!(State);

impl ZellijPlugin for State {
    fn load(&mut self, _: BTreeMap<String, String>) {
        request_permission(&[PermissionType::ReadPaneContents, PermissionType::ReadCliPipes,
            PermissionType::ChangeApplicationState]);
    }
    fn pipe(&mut self, message: PipeMessage) -> bool {
        if let PipeSource::Cli(id) = message.source {
            block_cli_pipe_input(&id);
            let result = execute(message.payload.as_deref().unwrap_or(""));
            let output = result.unwrap_or_else(|| serde_json::json!({"error":"unavailable"}));
            cli_pipe_output(&id, &format!("{}\n", output));
            unblock_cli_pipe_input(&id);
        }
        false
    }
}

fn execute(payload: &str) -> Option<serde_json::Value> {
    if payload.len() > 128 { return None; }
    let input: serde_json::Value = serde_json::from_str(payload).ok()?;
    let pane = PaneId::Terminal(u32::try_from(input.get("pane")?.as_u64()?).ok()?);
    let mut contents = get_pane_scrollback(pane, true).ok()?;
    if let Some(target) = input.get("line") {
        let target = usize::try_from(target.as_u64()?).ok()?.min(MAX_LINES);
        let history = contents.lines_above_viewport.len() + contents.lines_below_viewport.len();
        if history > MAX_LINES { return None; }
        if target >= history {
            scroll_to_bottom_in_pane_id(pane);
        } else if target == 0 {
            scroll_to_top_in_pane_id(pane);
        } else {
            let mut above = contents.lines_above_viewport.len();
            if target < above {
                scroll_to_top_in_pane_id(pane);
                above = 0;
            }
            // In 0.44.3 page-down moves content rows; page-up has different
            // semantics. Bound each seek batch so a drag cannot starve input.
            let rows = contents.viewport.len().max(1);
            for _ in 0..MAX_ACTIONS {
                if above >= target { break; }
                if target - above >= rows {
                    page_scroll_down_in_pane_id(pane);
                    above += rows;
                } else {
                    scroll_down_in_pane_id(pane);
                    above += 1;
                }
            }
        }
        contents = get_pane_scrollback(pane, true).ok()?;
    }
    let above = contents.lines_above_viewport.len();
    let below = contents.lines_below_viewport.len();
    let rows = contents.viewport.len();
    if above + below > MAX_LINES || rows > 200 { return None; }
    Some(serde_json::json!({"above":above,"below":below,"rows":rows.max(1)}))
}
