export type AppName = 'Notes' | 'Chat' | 'Terminal' | 'Files' | 'Leaf';
export type Scenario = 'build' | 'context' | 'terminal';
export type State = {
  active: boolean; muted: boolean; generation: number; app: AppName;
  scenario: Scenario | null; build: number; exchange: number; buildExchange: number | null; terminalExchange: number | null;
  terminal: 'idle' | 'approval' | 'running' | 'done' | 'rejected';
  contextOpen: boolean; historyOpen: boolean; user: string; aoede: string;
};
export const initialState: State = {
  active: true, muted: false, generation: 0, app: 'Notes', scenario: null,
  build: 0, exchange: 0, buildExchange: null, terminalExchange: null, terminal: 'idle', contextOpen: true, historyOpen: false,
  user: 'I want the computer to feel a little more like a companion.',
  aoede: 'I’m here. We can talk while you work. What shall we make together?',
};
export type Action =
  | { type: 'scenario'; scenario: Scenario }
  | { type: 'progress'; generation: number; step: number }
  | { type: 'approve' | 'reject' | 'terminal.done' | 'mute' | 'context' | 'history' | 'reset' }
  | { type: 'voice'; active: boolean }
  | { type: 'open'; app: AppName }
  | { type: 'say'; text: string };
export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset': return { ...initialState, generation: state.generation + 1 };
    case 'scenario': {
      const common = { ...state, scenario: action.scenario, exchange: state.exchange + 1, active: true, muted: false };
      if (action.scenario === 'context') return { ...common, app: 'Notes', contextOpen: true,
        user: 'What did we decide about my morning routine last time?',
        aoede: 'A short walk, then ten minutes of reading. I found the chat where you said you wanted mornings to feel less rushed.' };
      if (action.scenario === 'build') return { ...common, generation: state.generation + 1, app: 'Chat', build: 1, buildExchange: common.exchange,
        user: 'Build me a calm habit tracker. Use the ideas from our earlier chat.',
        aoede: 'I’ll build it in Chat, using your earlier notes. We can keep talking while I work.' };
      return { ...common, app: 'Terminal', terminal: 'approval', terminalExchange: common.exchange,
        user: 'Can you run the tests for the habit tracker?',
        aoede: 'I’ve opened Terminal with the command ready. You can check it before I run it.' };
    }
    case 'progress':
      if (action.generation !== state.generation || !state.build || action.step <= state.build) return state;
      return { ...state, build: Math.min(4, action.step), aoede: action.step === 4 && state.buildExchange === state.exchange
        ? 'Your habit tracker is ready. The build and launch checks passed. Shall we open it?'
        : state.aoede };
    case 'approve': return state.terminal !== 'approval' ? state : { ...state, terminal: 'running', exchange: state.exchange + 1, terminalExchange: state.exchange + 1, aoede: 'Running them now. I’ll let you know how it goes.' };
    case 'reject': return state.terminal !== 'approval' ? state : { ...state, terminal: 'rejected', exchange: state.exchange + 1, aoede: 'All right. The command hasn’t run.' };
    case 'terminal.done': return state.terminal !== 'running' ? state : { ...state, terminal: 'done', aoede: state.terminalExchange === state.exchange ? 'All six tests passed. Your habit tracker is ready to use.' : state.aoede };
    case 'voice': return { ...state, active: action.active };
    case 'mute': return { ...state, muted: !state.muted };
    case 'context': return { ...state, contextOpen: !state.contextOpen };
    case 'history': return { ...state, historyOpen: !state.historyOpen };
    case 'open': return action.app === 'Leaf' && state.build !== 4 ? state : { ...state, app: action.app };
    case 'say': return { ...state, exchange: state.exchange + 1, user: action.text, aoede: state.build > 0 && state.build < 4
      ? 'Yes, I can keep it simple. The app is still building in Chat; I’m right here.'
      : 'Let’s try building an app, finding an earlier chat, or running its tests. Choose one below to explore the preview.' };
  }
}
