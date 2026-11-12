# Manual QA checklist (Premiere Pro 2026)

Run on the editor's Windows machine with the installed `.ccx`. Record Premiere version + build (Settings ›
Copy diagnostics), OS, pass/fail and notes. An item is "Tested in Premiere"
in `COMPATIBILITY.md` only after it passes here.

## Phase 1 — Foundation

| ID | Steps | Expected |
|---|---|---|
| P1-01 | Load `plugin/dist/manifest.json` in UDT, open the panel, dock it in a narrow column (~280 px) | Panel renders, no console errors, nav wraps, nothing overflows sideways |
| P1-02 | Header pills with no project open | "Pr 26.x" green (26.3+) or amber; Project card says "Open a project" |
| P1-03 | Open a project with a 3-camera sequence; open the sequence | Project card lists the sequence, frame size, fps (check 23.976 / 25 / 29.97), duration, track labels V1.. / A1.. match the timeline headers, clip counts match |
| P1-04 | Move the playhead, press Refresh | Playhead timecode matches the Program Monitor (non-drop display) |
| P1-05 | Switch to another sequence in the Timeline | Panel refreshes by itself (events) within ~1 s |
| P1-06 | Settings › Copy diagnostics | Line "Origins seen by engine" is filled in. **Send the value.** |
| P1-08 | Press **Inspect sequence media** | Progress bar, then one row per file with TC/fps/audio; offline media reported as missing |
| P1-09 | Press it again | Rows marked "cached", finishes faster |
| P1-10 | Start inspection on a long file set, press **Cancel** | Job ends as cancelled; panel stays usable |
| P1-11 | End `pythonw.exe` in Task Manager while the panel is open | Within ~5 s the Engine pill turns red; **Restart engine** brings it back |
| P1-12 | **Create project bins** | Bin "Multimedia & AI Group" with 01–06 sub-bins. Edit › Undo removes them (2 steps). Pressing again creates nothing |
| P1-13 | **Add test marker** | Comment marker at the playhead named "MAG check". One Undo removes it |
| P1-14 | Restart Premiere, open panel | Engine starts again by itself; last view and language remembered |
| P1-15 | Unplug the drive holding one camera file, inspect | That file: "File not found or drive disconnected"; others still inspected |
| P1-16 | Press **عربي** | Whole panel in Arabic, right-to-left; sentences with In/Out read in the right order |
| P1-17 | Install the `.ccx`, open the panel | Engine card goes *starting → running* with no window appearing and no pairing code |
| P1-18 | Quit Premiere; check Task Manager | No `pythonw.exe` from the plugin folder remains |
| P1-19 | Mark In/Out on a 3-camera + 2-mic sequence, press **Cut engine test** | New `_CUT_TEST_` sequence opens; panel says all pieces verified; play across the cut: picture and sound stay in sync on every track; original sequence unchanged |
| P1-20 | Ctrl+Z repeatedly after P1-19 | The test's steps undo cleanly ("MAG: ..." in Edit › Undo) |

## Later phases (to be filled per phase)

| ID | Question from the audit |
|---|---|
| P2-03 | Linked audio placement by `createOverwriteItemAction` |
| P3-01 | Trim actions precision and cost at 1,000+ actions |
| P3-02 | Volume keyframes on audio clips |
| P4-02 | Disabled upper-track clips reveal the enabled one (playback + export) |
| P6-01 | SRT import + placement creates a caption track |
| P7-02 | `ComponentParam.createKeyframe(string)` edits MOGRT text on 26.x |
