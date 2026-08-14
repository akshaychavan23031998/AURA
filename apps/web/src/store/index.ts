import { configureStore } from "@reduxjs/toolkit";

import { appReducer } from "./slices/app.slice";
import { voiceReducer } from "./slices/voice.slice";

export const makeStore = () =>
  configureStore({
    reducer: {
      app: appReducer,
      voice: voiceReducer,
    },
  });

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];
