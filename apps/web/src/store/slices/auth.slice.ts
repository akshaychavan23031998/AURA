import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type AuthStatus =
  | "bootstrapping"
  | "unauthenticated"
  | "authenticating"
  | "authenticated"
  | "refreshing"
  | "session-expired"
  | "logging-out"
  | "error";

export interface AuthState {
  status: AuthStatus;
  error?: string;
}

const initialState: AuthState = { status: "bootstrapping" };

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    setAuthStatus(state, action: PayloadAction<AuthStatus>) {
      state.status = action.payload;
      if (action.payload !== "error") state.error = undefined;
    },
    setAuthError(state, action: PayloadAction<string>) {
      state.status = "error";
      state.error = action.payload;
    },
  },
});

export const { setAuthError, setAuthStatus } = authSlice.actions;
export const authReducer = authSlice.reducer;
