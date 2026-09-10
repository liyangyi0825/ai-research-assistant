import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const GLOBAL_KEYS = [
  "window",
  "self",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "Event",
  "MouseEvent",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

type GlobalKey = (typeof GLOBAL_KEYS)[number];

export type ReactDomHarness = {
  window: Window;
  container: HTMLElement;
  root: Root;
  render(node: ReactNode): Promise<void>;
  flush(): Promise<void>;
  cleanup(): Promise<void>;
};

export function createReactDomHarness(): ReactDomHarness {
  const browserWindow = new Window({ url: "http://localhost/" });
  const descriptors = new Map<GlobalKey, PropertyDescriptor | undefined>();
  for (const key of GLOBAL_KEYS) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  const replacements: Record<GlobalKey, unknown> = {
    window: browserWindow,
    self: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    Node: browserWindow.Node,
    Element: browserWindow.Element,
    HTMLElement: browserWindow.HTMLElement,
    HTMLIFrameElement: browserWindow.HTMLIFrameElement,
    Event: browserWindow.Event,
    MouseEvent: browserWindow.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: replacements[key],
    });
  }

  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  const root = createRoot(
    container as unknown as Parameters<typeof createRoot>[0],
  );

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  return {
    window: browserWindow,
    container: container as unknown as HTMLElement,
    root,
    async render(node) {
      await act(async () => {
        root.render(node);
      });
      await flush();
    },
    flush,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      await browserWindow.happyDOM.close();
      for (const key of GLOBAL_KEYS) {
        const descriptor = descriptors.get(key);
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}
