import { contextBridge, ipcRenderer } from "electron";
import {
  NATIVE_APP_QUERY_CHANNEL,
  createNativeAppDatabase,
  type NativeAppQuery,
} from "../shared/native-app-bridge";

const database = createNativeAppDatabase((query: NativeAppQuery) =>
  ipcRenderer.invoke(NATIVE_APP_QUERY_CHANNEL, query));

contextBridge.exposeInMainWorld("MatrixOS", Object.freeze({ db: database }));
