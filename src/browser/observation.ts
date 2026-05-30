export type AriaNodeSummary = {
  ref: string;
  role: string;
  name: string;
  tag: string;
  selector: string;
  text: string;
  value?: string;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type Observation = {
  url: string;
  title: string;
  visibleText: string;
  ariaTree?: string;
  ariaNodes?: AriaNodeSummary[];
  screenshotPath?: string;
  consoleErrors: string[];
  failedRequests: string[];
  timestamp: string;
};
