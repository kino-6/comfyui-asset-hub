import {ensureStyleOnce} from '@laurigates/comfy-modal-kit';

export function ensureHubStyles(){
 ensureStyleOnce('asset-hub-style-v3',`
 .ah-view-switch{display:flex;gap:4px;margin-left:auto}.ah-view-switch .ib-density-seg{width:auto;padding:7px 10px;font-size:12px}
 .ah-asset small{display:block;color:#9baaa7;font-size:11px}.ah-processing{border-color:#d8b66c!important}.ah-processing .ah-asset::before{content:"処理中 · ";color:#f2d595}
 .ah-asset{font-size:12px;color:#a4bfb4;padding:5px 8px;line-height:1.5;min-height:25px}.ah-asset[data-state=compacted]{color:#80d6ae}
 .ah-compact-ui .ib-grid[data-density=grid]{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
 .ah-card-primary{background:#315b4b!important}.ah-compact-ui .ib-actions{flex-wrap:wrap}.ah-compact-ui .ib-grid[data-density=dense]{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
 .ah-compact-ui .ib-grid[data-density=dense] .ib-actions [data-action]{display:none}
 .ah-compact-ui .ib-grid[data-density=list] .ib-card.is-file{grid-template-columns:64px minmax(130px,1fr) minmax(140px,.7fr) 260px;grid-template-areas:"thumb name asset acts" "thumb meta asset acts";align-items:center;min-height:70px;padding:6px}
 .ah-compact-ui .ib-grid[data-density=list] .ah-asset{grid-area:asset}.ah-compact-ui .ib-grid[data-density=list] .ib-actions{justify-content:flex-end}
 .ah-compact-ui .ib-grid[data-density=list] .ib-thumb{height:64px}
 .ah-run-meter{width:130px;height:6px;accent-color:#67cba2}.ah-record-thumb{width:52px;height:52px;object-fit:contain;background:#15191f;border-radius:4px}
 .ah-unused,.ah-compact-ui .ib-selbar,.ah-compact-ui .ib-selected-badge{display:none!important}
 .ah-compact-ui .ib-check{display:flex}.ah-compact-ui .ib-check::before{border-radius:4px!important}.ah-compact-ui .ib-stars{display:none}.ah-compact-ui .ib-actions{gap:4px}
 .ah-compact-ui .ib-act{white-space:nowrap;min-height:30px;height:32px;font-size:12px;width:auto;min-width:44px;padding:4px 8px}
 .ah-compact-ui .ib-dir-move,.ah-compact-ui .ib-dir-del{display:none!important}
 .ah-toolbar,.ah-pages,.ah-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .ah-toolbar{width:100%;padding:4px 0}.ah-toolbar select{max-width:min(340px,40vw)}
 .ah-pages{margin-left:auto;font-size:12px}.ah-progress{font-size:12px;color:#aac7bd;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .ah-notice{font-size:12px;color:#ffbc97;overflow-wrap:anywhere}.ah-notice:empty{display:none}
 .ah-total-meter:not([hidden]){display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#aebeb8}
 .ah-work{width:100%;font-size:12px;color:#b7c8c3}.ah-work summary{cursor:pointer;width:fit-content;padding:3px 0}
 .ah-work-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px 16px;margin-top:5px}
 .ah-work-item{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px}
 .ah-work-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ah-work-phase{color:#a6d4c3;white-space:nowrap}
 .ah-work-item progress{appearance:none;width:100%;height:4px;border:0;background:#3e4449;align-self:center}
 .ah-work-item progress::-webkit-progress-bar{background:#3e4449}.ah-work-item progress::-webkit-progress-value{background:#8ac9b5}.ah-work-item progress::-moz-progress-bar{background:#8ac9b5}
 .ah-work-time{color:#9aa5ae;text-align:right}
 .ah-background{display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap}.ah-task{padding:10px 0;border-bottom:1px solid #ffffff15;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ah-task span{flex:1;min-width:180px;overflow-wrap:anywhere}
 .ah-toolbar button,.ah-pages button,.ah-panel button,.ah-panel select,.ah-toolbar select,.ah-panel input[data-path]{font:inherit;background:#2d3a3e;border:1px solid #50635f;border-radius:6px;color:#e7eeec;padding:7px 11px;cursor:pointer}
 .ah-panel button:disabled,.ah-toolbar button:disabled,.ah-pages button:disabled{opacity:.4;cursor:default}
 .ah-primary{background:#315f50!important}.ah-count{font-size:12px;color:#b7c8c3;min-width:55px}
 .ah-panel{width:min(1000px,94vw)!important;max-width:94vw!important;max-height:88dvh!important;display:flex;flex-direction:column;gap:12px;color:#eee}
 .ah-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.ah-head h2{margin:0;font-size:20px}
 .ah-records{overflow:auto;min-height:100px;max-height:57dvh;flex:1;overflow-anchor:none}
 .ah-record{user-select:none;display:grid;grid-template-columns:24px 56px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid #ffffff15;cursor:pointer}
 .ah-record strong{display:block;font-size:13px;overflow-wrap:anywhere}.ah-record small{display:block;font-size:12px;color:#aebeb8;margin-top:4px;overflow-wrap:anywhere}
 .ah-record input{width:17px;height:17px;cursor:pointer}.ah-record.is-selected{background:#25433b55}
 .ah-record button{font-size:12px}.ah-state{color:#9edcc3}.ah-detail{font-size:12px;color:#aebeb8;line-height:1.5}.ah-detail summary{cursor:pointer}
 @media(max-width:700px){.ah-record{grid-template-columns:22px minmax(0,1fr)}.ah-record button{grid-column:2}.ah-pages{margin-left:0}}
 `);
}
