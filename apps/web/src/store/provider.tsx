"use client";

import { useState } from "react";
import { Provider } from "react-redux";

import { makeStore } from "./index";

export function StoreProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [store] = useState(makeStore);

  return <Provider store={store}>{children}</Provider>;
}
