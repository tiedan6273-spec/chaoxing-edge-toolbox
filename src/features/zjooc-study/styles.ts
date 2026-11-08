export const zjoocStudyStyles = `
.zjooc-study-view { display: grid; gap: 8px; }
.zjooc-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; }
.zjooc-enable { cursor: pointer; gap: 10px; }
.zjooc-enable > span { min-width: 0; }
.zjooc-enable .description { display: block; }
.zjooc-playback { display: grid; gap: 4px; }
.zjooc-playback label { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; color: var(--text-title); font-size: 13px; font-weight: 700; }
.zjooc-playback select { flex: 1; min-width: 0; max-width: 210px; min-height: 34px; padding: 5px 8px; border: 2px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-body); font: inherit; }
.zjooc-playback select:disabled { cursor: not-allowed; opacity: .65; }
.zjooc-playback p { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.zjooc-start-position > button { justify-self: start; }
.zjooc-progress { display: grid; gap: 5px; padding: 10px; background: var(--surface-page); border: 1px solid var(--border-inner); border-radius: var(--radius-md); }
.zjooc-progress p { margin: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 1.55; }
.zjooc-project, .zjooc-rate, .zjooc-count { color: var(--text-muted); }
.zjooc-chapter { color: var(--text-title); font-weight: 600; }
.zjooc-resource, .zjooc-message { color: var(--text-body); }
.zjooc-message[data-kind="error"] { color: var(--error-text); }
.zjooc-progress-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; padding-top: 7px; border-top: 1px solid var(--border-inner); }
.zjooc-count { flex: 1; min-width: 0; }
.zjooc-count > span { display: inline-block; white-space: nowrap; }
.zjooc-pending, .zjooc-skipped { border: 1px solid var(--border-inner); border-radius: var(--radius-md); color: var(--text-body); font-size: 12px; }
.zjooc-pending summary, .zjooc-skipped summary { padding: 7px 10px; cursor: pointer; }
.zjooc-pending ul, .zjooc-skipped ul { margin: 0; padding: 0 12px 10px 26px; overflow-wrap: anywhere; }
`;
