/* eslint-disable @typescript-eslint/no-explicit-any */
interface Window {
  glimpse: {
    send(data: unknown): void;
    close(): void;
    cursorTip: unknown;
  };
  require: {
    config(value: unknown): void;
    (modules: string[], callback: () => void): void;
  };
  monaco: any;
  __responseReviewReceive?: (message: unknown) => void;
}
