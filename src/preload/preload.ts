// The only bridge between the page and the app. Exposes a fixed set of calls.
import { contextBridge, ipcRenderer } from 'electron';
import type { Api, UiEvent } from '../shared/types';

const api: Api = {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  submit: (text, via) => ipcRenderer.invoke('submit', text, via),
  answerQuestion: (id, value) => ipcRenderer.invoke('answerQuestion', id, value),
  cancelTask: (id) => ipcRenderer.invoke('cancelTask', id),
  setPriority: (id, p) => ipcRenderer.invoke('setPriority', id, p),
  approve: (id, d) => ipcRenderer.invoke('approve', id, d),
  switchAgent: (id) => ipcRenderer.invoke('switchAgent', id),
  checkHealth: () => ipcRenderer.invoke('checkHealth'),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  updateSettings: (patch) => ipcRenderer.invoke('updateSettings', patch),
  newConversation: () => ipcRenderer.invoke('newConversation'),
  setCredential: (name, value) => ipcRenderer.invoke('setCredential', name, value),
  credentialStatus: () => ipcRenderer.invoke('credentialStatus'),
  cloudTts: (text, voice, speed) => ipcRenderer.invoke('cloudTts', text, voice, speed),
  cloudStt: (audio, mime) => ipcRenderer.invoke('cloudStt', audio, mime),
  transcribe: (audio) => ipcRenderer.invoke('transcribe', audio),
  preloadSpeech: () => ipcRenderer.invoke('preloadSpeech'),
  synthesize: (text, voice, speed) => ipcRenderer.invoke('synthesize', text, voice, speed),
  modelStatus: () => ipcRenderer.invoke('modelStatus'),
  downloadModels: (ids) => ipcRenderer.invoke('downloadModels', ids),
  systemInfo: () => ipcRenderer.invoke('systemInfo'),
  logRenderer: (level, message) => ipcRenderer.send('log', level, message),
  onEvent: (cb) => {
    const handler = (_: unknown, e: UiEvent) => cb(e);
    ipcRenderer.on('ui-event', handler);
    return () => ipcRenderer.removeListener('ui-event', handler);
  },
};

contextBridge.exposeInMainWorld('vcc', api);
if (process.env.VCC_TEST === '1') contextBridge.exposeInMainWorld('vccTest', { killSpeech: () => ipcRenderer.invoke('test:killSpeech') });
