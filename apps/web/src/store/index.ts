import { configureStore } from "@reduxjs/toolkit";

import { appReducer } from "./slices/app.slice";

export const makeStore = () =>
  configureStore({
    reducer: {
      app: appReducer,
    },
  });

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];
