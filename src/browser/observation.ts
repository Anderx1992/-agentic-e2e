export type Observation = {
  url: string;
  title: string;
  visibleText: string;
  screenshotPath?: string;
  consoleErrors: string[];
  failedRequests: string[];
  timestamp: string;
};
