import { configureStore } from "@reduxjs/toolkit";

import { appReducer } from "./slices/app.slice";
import { voiceReducer } from "./slices/voice.slice";
import { authReducer } from "./slices/auth.slice";

export const makeStore = () =>
  configureStore({
    reducer: {
      app: appReducer,
      voice: voiceReducer,
      auth: authReducer,
    },
  });

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];
