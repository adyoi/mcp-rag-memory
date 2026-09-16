/**
 * Minimal ambient typings for @opencode-ai/plugin so the source builds
 * standalone. At runtime opencode provides the real module.
 */
declare module "@opencode-ai/plugin" {
  export interface PluginInput {
    client: any;
    project: string;
    directory: string;
    $: any;
  }

  export interface ToolInput {
    name: string;
    [key: string]: any;
  }

  export interface ToolResult {
    args?: Record<string, unknown>;
    content?: unknown;
    isError?: boolean;
    [key: string]: any;
  }

  /** Loose hook surface; each property is optional. */
  export interface Hooks {
    config?: (cfg: any) => void | Promise<void>;
    event?: (input: any) => void | Promise<void>;
    "chat.message"?: (input: any) => void | Promise<void>;
    "chat.params"?: (input: any, output: any) => void | Promise<void>;
    "chat.headers"?: (input: any, output: any) => void | Promise<void>;
    "tool.execute.before"?: (input: ToolInput, output: ToolResult) => void | Promise<void>;
    "tool.execute.after"?: (input: ToolInput, output: ToolResult) => void | Promise<void>;
    "tool.definition"?: (input: any, output: any) => void | Promise<void>;
    "command.execute.before"?: (input: any, output: any) => void | Promise<void>;
    "shell.env"?: (input: any, output: any) => void | Promise<void>;
    "permission.ask"?: (input: any, output: any) => void | Promise<void>;
    [key: string]: any;
  }

  export type Plugin = (input: PluginInput, options?: any) => Promise<Hooks>;
}