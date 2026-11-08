export const questionAnswerStyles = `
.saved-quick-actions { display:flex; flex-wrap:wrap; gap:6px; align-items:center; max-width:100%; }
.saved-quick-actions span { font-size:12px; overflow-wrap:anywhere; }
.similar-references { margin:10px 0; padding:8px; border:1px dashed var(--border, #24272e); border-radius:8px; font-size:13px; }
.similar-references article { padding:10px 0; border-top:1px solid #ddd8c8; }
.similar-references pre, .similar-references p { white-space:pre-wrap; overflow-wrap:anywhere; }
.similar-differences { color:#9b4310; font-weight:600; }
.answer-local-bank { margin-block: 6px; border: 1px solid var(--border-inner); border-radius: 8px; padding: 8px; }
.answer-local-bank-body { display: grid; gap: 8px; padding-top: 8px; }
.answer-local-bank-body label { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; overflow-wrap: anywhere; }
.answer-local-bank-body input[type=checkbox] { width: 16px; height: 16px; flex: 0 0 16px; margin-top: 1px; }
.answer-local-bank-list { display: grid; gap: 5px; max-height: 160px; overflow-y: auto; }
.question-answer-view { display: grid; gap: 8px; }
.answer-heading, .answer-result-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.answer-heading .section-title { min-width: 0; }
.answer-configuration { border: 1px solid var(--border-inner); border-radius: 10px; color: var(--text-body); font-size: 12px; }
.answer-configuration > summary { padding: 6px 9px; cursor: pointer; border-radius: inherit; }
.answer-configuration > summary:hover { background: var(--surface-page); }
.answer-configuration-content { display: grid; gap: 7px; padding: 8px; border-top: 1px solid var(--border-inner); }
.question-answer-view .phase-badge[data-phase="running"], .question-answer-view .phase-badge[data-phase="querying"], .question-answer-view .phase-badge[data-phase="filled"] { color: var(--primary-hover); background: var(--tint-bg); border-color: var(--tint-border); }
.question-answer-view .phase-badge[data-phase="error"] { color: var(--error-text); background: var(--error-bg); border-color: var(--error-border); }
.question-answer-view .phase-badge[data-phase="existing"], .question-answer-view .phase-badge[data-phase="needs-review"] { color: var(--warning-text); background: var(--warning-bg); border-color: var(--warning-border); }
.answer-source-settings { display: grid; gap: 7px; }
.answer-source-label { display: grid; gap: 4px; min-width: 0; color: var(--text-title); font-size: 12px; }
.answer-source-label select { min-width: 0; width: 100%; min-height: 32px; padding: 4px 7px; border: 1px solid var(--border); border-radius: 10px; color: var(--text-title); background: var(--surface); font: inherit; }
.answer-source-label select:focus-visible { border-color: var(--primary); box-shadow: 0 0 0 3px var(--tint-bg); }
.answer-source-label select:disabled { opacity: .55; cursor: not-allowed; }
.answer-settings-actions, .answer-actions, .answer-result-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.question-answer-view .button { min-height: 30px; padding: 4px 8px; border-radius: 10px; }
.answer-settings-actions { flex-direction: row; }
.answer-review-actions { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--border-inner); border-radius: 10px; background: var(--surface-page); }
.answer-review-actions .button { width: 100%; }
.answer-review-status { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.answer-review-status[data-kind="error"], .answer-review-status[data-kind="suspect"] { color: var(--error-text); }
.answer-review-status[data-kind="uncertain"] { color: var(--warning-text); }
.answer-review-status[data-kind="info"] { color: var(--primary-hover); }
.answer-config-status { margin: 0; padding: 7px 8px; border: 1px solid var(--tint-border); border-radius: 10px; color: var(--text-body); background: var(--tint-bg); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.answer-config-status[data-kind="warning"] { color: var(--warning-text); border-color: var(--warning-border); background: var(--warning-bg); }
.answer-message { margin: 0; color: var(--text-body); white-space: pre-wrap; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.answer-message:empty { display: none; }
.answer-message[data-kind="error"] { padding: 6px 8px; border-radius: 10px; color: var(--error-text); background: var(--error-bg); }
.answer-progress-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.answer-progress { margin: 0; color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1.5; }
.answer-progress-line > [data-answer-action="follow-progress"] { margin-left: auto; min-height: 25px; padding: 2px 6px; font-size: 11px; }
.answer-paper-status { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.answer-paper-status[data-kind="warning"] { color: var(--warning-text); }
.answer-question-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 5px; }
.answer-question-grid .button { min-width: 0; padding: 4px 2px; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.answer-question-grid .button[data-phase="filled"], .answer-question-grid .button[data-phase="searched"], .answer-question-grid .button[data-phase="existing"] { background: var(--tint-bg); color: var(--primary-hover); }
.answer-question-grid .button[data-phase="error"], .answer-question-grid .button[data-phase="needs-review"], .answer-question-grid .button[data-phase="unsupported"] { background: var(--warning-bg); color: var(--warning-text); }
.answer-question-grid .button[data-phase="querying"] { border-color: var(--primary); color: var(--primary-hover); }
.answer-question-grid .button[data-review="suspect"] { border-color: var(--error-border); color: var(--error-text); background: var(--error-bg); }
.answer-question-grid .button[data-review="uncertain"] { border-color: var(--warning-border); color: var(--warning-text); background: var(--warning-bg); }
.answer-question-grid .button[aria-pressed="true"] { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); font-weight: 700; }
.answer-results { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.answer-result { display: grid; gap: 6px; padding: 8px 10px; min-width: 0; border: 1px solid var(--border-inner); border-radius: 12px; background: var(--surface-page); }
.answer-result[data-review="suspect"] { border-color: var(--error-border); box-shadow: inset 3px 0 0 var(--error-text); }
.answer-result[data-review="uncertain"] { border-color: var(--warning-border); box-shadow: inset 3px 0 0 var(--warning-text); }
.answer-result-title { min-width: 0; color: var(--text-title); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
.answer-result-stem, .answer-result-message { margin: 0; color: var(--text-body); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.answer-result-stem { padding-bottom: 3px; }
.answer-question-content, .answer-field, .answer-child { display: grid; gap: 5px; min-width: 0; color: var(--text-body); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.answer-field p, .answer-child p { margin: 0; }
.answer-field, .answer-child { padding-top: 5px; border-top: 1px solid var(--border-inner); }
.answer-options { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.answer-options li { padding: 5px 7px; border-radius: 7px; background: var(--surface); }
.answer-question-images { display: grid; gap: 8px; }
.answer-question-image { margin: 0; min-width: 0; }
.answer-question-image img { display: block; max-width: 100%; height: auto; max-height: 260px; object-fit: contain; border-radius: 6px; }
.answer-image-caption, .answer-image-error { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.answer-copy-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.answer-copy-status { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.answer-export { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--border-inner); border-radius: 10px; background: var(--surface-page); }
.answer-export-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; }
.answer-export-controls label { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 5px; min-width: 0; font-size: 11px; color: var(--text-body); }
.answer-export-controls select { min-width: 0; max-width: 100%; min-height: 32px; padding: 4px 5px; border: 1px solid var(--border-strong); border-radius: 7px; color: var(--text-body); background: var(--surface); font: inherit; }
.answer-export-controls .button { min-width: 0; white-space: normal; }
.answer-export-help, .answer-export-status { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.answer-export-status[data-kind="error"] { color: var(--error-text); }
.answer-copy-fallback { box-sizing: border-box; width: 100%; min-height: 110px; padding: 8px; resize: vertical; color: var(--text-body); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 12px; }
.answer-current { padding: 7px 8px; border: 1px solid var(--border-inner); border-radius: 8px; background: var(--surface); }
.answer-answer-label { color: var(--text-muted); font-size: 11px; }
.answer-current pre { margin: 4px 0 0; color: var(--text-body); white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; line-height: 1.6; }
.answer-current pre[data-code="true"], .answer-review-suggestion pre[data-code="true"] { max-height: 240px; overflow: auto; }
.answer-review { display: grid; gap: 6px; padding: 7px 8px; border: 1px solid var(--border-inner); border-radius: 8px; background: var(--surface); }
.answer-review-heading, .answer-review-reason { margin: 0; color: var(--text-body); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.answer-review-heading { font-weight: 700; }
.answer-review-suggestion pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; line-height: 1.6; }
.answer-result[data-review="suspect"] .answer-review { border-color: var(--error-border); background: var(--error-bg); }
.answer-result[data-review="suspect"] .answer-review-heading { color: var(--error-text); }
.answer-result[data-review="uncertain"] .answer-review { border-color: var(--warning-border); background: var(--warning-bg); }
.answer-result[data-review="uncertain"] .answer-review-heading { color: var(--warning-text); }
.answer-completion-status { margin: 0; padding: 7px 8px; border-radius: 9px; background: var(--tint-bg); color: var(--primary-hover); font-size: 12px; line-height: 1.5; }
.answer-completion-status[data-kind="warning"] { background: var(--warning-bg); color: var(--warning-text); }
.answer-result-message { color: var(--text-muted); }
.answer-result-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; color: var(--text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.answer-result-tags { color: var(--primary-hover); }
.answer-result-preview { border: 1px solid var(--border-inner); border-radius: 8px; color: var(--text-body); font-size: 12px; }
.answer-result-preview summary { padding: 5px 8px; cursor: pointer; border-radius: inherit; }
.answer-result-preview summary:hover { background: var(--surface); }
.answer-result-preview pre { margin: 0; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.6; }
.answer-replace-confirm { padding: 7px 8px; border: 1px solid var(--warning-border); border-radius: 10px; color: var(--warning-text); background: var(--warning-bg); }
.answer-replace-confirm p { margin: 0 0 6px; font-size: 11px; line-height: 1.5; }
.answer-replace-confirm .button + .button { margin-left: 6px; }
.answer-boundary { margin: 0; line-height: 1.5; }
.page-tools-workspace { display: grid; gap: 8px; }
.answer-operation-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; padding: 8px; border: 2px solid var(--text-body); border-radius: 9px; background: var(--surface-page); }
.answer-operation-controls label { display: grid; gap: 5px; min-width: 0; font-size: 11px; font-weight: 700; }
.answer-operation-controls select { width: 100%; min-width: 0; padding: 6px 3px; font: inherit; background: var(--surface); color: var(--text-body); border: 1px solid var(--border-inner); border-radius: 5px; }
.answer-range-anchor { grid-column: 1 / -1; margin: 0; overflow-wrap: anywhere; }
.answer-reference { padding: 8px; border: 1px solid var(--border-inner); border-radius: 8px; background: var(--tint-bg); }
.answer-reference pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; line-height: 1.6; }
.answer-platform-review { padding: 8px; border: 1px dashed var(--border-inner); border-radius: 8px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.answer-difference-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px; border: 2px solid var(--danger-border, #b74141); border-radius: 8px; background: var(--danger-bg, #fff0ef); color: var(--danger-text, #8f2525); font-size: 12px; font-weight: 700; }
[data-answer-action="select-question"][data-review="suspect"] { position: relative; }
[data-answer-action="select-question"][data-review="suspect"]::after { content: '≠'; position: absolute; top: -5px; right: -3px; width: 14px; height: 14px; border-radius: 50%; background: #a82f37; color: white; font: bold 12px/14px sans-serif; }
.scene-tools { margin-top: 7px; border: 1px solid var(--border-inner); border-radius: 10px; color: var(--text-body); font-size: 12px; }
.scene-tools > summary { padding: 7px 9px; border-radius: inherit; cursor: pointer; }
.scene-tools > summary:hover { background: var(--surface-page); }
.scene-tools-content { display: grid; gap: 8px; padding: 8px; border-top: 1px solid var(--border-inner); }
@container toolbox (max-width: 300px) {
  .answer-source-settings { grid-template-columns: minmax(0, 1fr); }
  .answer-settings-actions { flex-direction: row; }
  .answer-settings-actions .button { flex: 1 1 auto; }
}
`;
