export type NLTestCase = {
  id: string;
  name: string;
  app: {
    start_url: string;
  };
  task: string;
  success_criteria: string;
  failure_criteria?: string;
  constraints?: {
    max_steps?: number;
    timeout_ms?: number;
    allow_external_navigation?: boolean;
    headless?: boolean;
  };
  artifacts?: {
    screenshots?: boolean;
    network?: boolean;
    console?: boolean;
  };
};
