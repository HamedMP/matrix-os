"""Reviewed qualification scope; candidate code cannot choose phases or flags."""
REPOSITORY = 'HamedMP/matrix-os'
LANES = ('unit','mechanical','web','e2e')
ELECTRON = {
 'grid':['tests/e2e/terminal-soft-grid.e2e.test.ts'],
 'electron-download':['tests/e2e/desktop/file-download.e2e.test.ts'],
 'electron-input':['tests/e2e/desktop/canonical-input.e2e.test.ts'],
 'electron-providers':['tests/e2e/provider-authorization-electron.e2e.test.ts','tests/e2e/desktop/provider-auth-terminal.e2e.test.ts','tests/e2e/desktop/agents-providers-figma.e2e.test.ts','tests/e2e/desktop/agents-providers-button-contrast.e2e.test.ts','tests/e2e/desktop/provider-settings-idle.e2e.test.ts'],
 'electron-folder':['tests/e2e/desktop/project-folder-picker-layout.e2e.test.ts'],
 'electron-clipboard':['tests/e2e/desktop/terminal-clipboard.e2e.test.ts'],
 'electron-drop':['tests/e2e/desktop/terminal-file-drop.e2e.test.ts'],
 'electron-snapshot':['tests/e2e/desktop/terminal-snapshot.e2e.test.ts'],
 'electron-release':['tests/e2e/desktop/release-alignment.e2e.test.ts'],
 'electron-title':['tests/e2e/desktop/chat-title-layout.e2e.test.ts'],
}
PHASES = {
 'setup':('checkout',*(p+'-'+lane for lane in LANES for p in ('install','source')),*(p+'-'+lane for lane in LANES for p in ('prerequisites','brand-build','source-prerequisites')),'unit-source-immutability','browsers','shell-browsers','postgres-start'),
 'unit':('unit','docs-parity-proof','source-coverage-proof','source-after-unit'),
 'mechanical':('typecheck','sync-build','sync-test','sync-publish','sdk-install','sdk','source-after-mechanical'),
 'web':('shell','source-after-web'),
 'e2e':('general','grid','source-before-desktop','desktop-build','electron-download','electron-input','electron-providers','electron-folder','electron-clipboard','electron-drop','electron-snapshot','source-before-release','electron-release','electron-title','source-after-e2e'),
 'cleanup':('postgres-stop',),'smoke':('icons',),
}
PROVENANCE = tuple('source-'+lane+'-'+stage+'.json' for lane in LANES for stage in ('postinstall','after-prerequisites','after-lane'))+('source-e2e-before-desktop.json','source-e2e-before-release.json')
REPORTS = ('unit','general',*ELECTRON)
HOST_PROVENANCE = tuple('host-source-'+lane+'.json' for lane in LANES)
ARTIFACTS = (*PROVENANCE,*HOST_PROVENANCE,'qualification.json','source-sha','image-id','inventory-sha256','exit-code','benchmark-exit-code','smoke-exit-code','smoke.json','smoke.stderr.log','trace','coverage.json','output.log','tools.json',*(f'timing-{lane}.tsv' for lane in PHASES),*(f'{phase}.json' for phase in REPORTS))
CONFIGS = ('vitest.config.ts','vitest.e2e.config.ts','.github/workflows/ci.yml')
MAX_FILE = 50*1024*1024
MAX_TOTAL = 150*1024*1024
