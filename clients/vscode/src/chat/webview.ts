import EventEmitter from "events";
import {
  commands,
  env,
  window,
  workspace,
  Disposable,
  ExtensionContext,
  Uri,
  TextEditor,
  Range,
  TextDocument,
  Webview,
  ColorThemeKind,
  ProgressLocation,
  Location,
  LocationLink,
  SymbolInformation,
  DocumentSymbol,
} from "vscode";
import type {
  ServerApiList,
  ChatView,
  EditorContext,
  LookupSymbolHint,
  SymbolInfo,
  FileLocation,
  GitRepository,
  ListFilesInWorkspaceParams,
  ListFileItem,
  FileRange,
  Filepath,
  ListSymbolsParams,
  ListSymbolItem,
  ChangeItem,
  GetChangesParams,
  EditorFileContext,
  TerminalContext,
  ChatCommand,
} from "tabby-chat-panel";
import * as semver from "semver";
import debounce from "debounce";
import { v4 as uuid } from "uuid";
import type { StatusInfo, Config } from "tabby-agent";
import type { GitProvider, Repository } from "../git/GitProvider";
import type { Client as LspClient } from "../lsp/client";
import { createClient } from "./createClient";
import { isBrowser } from "../env";
import { getLogger } from "../logger";
import { getEditorContext } from "./context";
import {
  localUriToChatPanelFilepath,
  chatPanelFilepathToLocalUri,
  vscodePositionToChatPanelPosition,
  vscodeRangeToChatPanelPositionRange,
  chatPanelLocationToVSCodeRange,
  isValidForSyncActiveEditorSelection,
  vscodeRangeToChatPanelLineRange,
  isCompatible,
} from "./utils";
import { listFiles } from "../findFiles";
import { wrapCancelableFunction } from "../cancelableFunction";
import mainHtml from "./html/main.html";
import errorHtml from "./html/error.html";
import { getTerminalContext } from "../terminal";

export class ChatWebview extends EventEmitter {
  private readonly logger = getLogger("ChatWebView");
  private disposables: Disposable[] = [];
  private webview: Webview | undefined = undefined;
  private client: ServerApiList | undefined = undefined;

  // The current server config used to load the chat panel.
  private currentConfig: Config["server"] | undefined = undefined;

  // A number to ensure the html is reloaded when assigned a new value
  private reloadCount = 0;

  // Once the chat iframe is loaded, the `createChatPanelApiClient` should be resolved,
  // and we can start to `initChatPanel`.
  // So we set a timeout here to ensure the `createChatPanelApiClient` is resolved,
  // otherwise we will show an error.
  private createClientTimeout: NodeJS.Timeout | undefined = undefined;

  // Pending actions to perform after the chat panel is initialized.
  private pendingActions: (() => Promise<void>)[] = [];

  // A callback list for invoke javascript function by postMessage
  private pendingCallbacks = new Map<string, (...arg: unknown[]) => void>();

  // Store the chat state to be reload when webview is reloaded
  private sessionStateMap = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly context: ExtensionContext,
    private readonly lspClient: LspClient,
    private readonly gitProvider: GitProvider,
  ) {
    super();
  }

  async init(webview: Webview) {
    webview.options = {
      enableScripts: true,
      enableCommandUris: true,
    };
    this.webview = webview;

    const statusListener = () => {
      this.checkStatusAndLoadContent();
    };
    this.lspClient.status.on("didChange", statusListener);
    this.disposables.push(
      new Disposable(() => {
        this.lspClient.status.off("didChange", statusListener);
      }),
    );
    this.checkStatusAndLoadContent();

    this.disposables.push(
      window.onDidChangeActiveTextEditor((editor) => {
        if (this.client) {
          this.debouncedNotifyActiveEditorSelectionChange(editor);
        }
      }),
    );
    this.disposables.push(
      window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === window.activeTextEditor && this.client) {
          this.debouncedNotifyActiveEditorSelectionChange(event.textEditor);
        }
      }),
    );

    this.disposables.push(
      webview.onDidReceiveMessage((event) => {
        switch (event.action) {
          case "chatIframeLoaded": {
            this.createClientTimeout = setTimeout(() => {
              const endpoint = this.currentConfig?.endpoint ?? "";
              if (!endpoint) {
                this.checkStatusAndLoadContent();
              } else {
                const command = `command:tabby.openExternal?${encodeURIComponent(`["${endpoint}/chat"]`)}`;
                this.loadErrorPage(
                  `Failed to load the chat panel. <br/>Please check your network to ensure access to <a href='${command}'>${endpoint}/chat</a>. <br/><br/><a href='command:tabby.reconnectToServer'><b>Reload</b></a>`,
                );
              }
            }, 10000);
            return;
          }
          case "syncStyle": {
            this.client?.["0.8.0"].updateTheme(event.style, this.getColorThemeString());
            return;
          }
          case "jsCallback": {
            this.pendingCallbacks.get(event.id)?.(...event.args);
            this.pendingCallbacks.delete(event.id);
            return;
          }
        }
      }),
    );
  }

  async dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.webview = undefined;
    this.client = undefined;
    if (this.createClientTimeout) {
      clearTimeout(this.createClientTimeout);
      this.createClientTimeout = undefined;
    }
    this.currentConfig = undefined;
  }

  async isFocused(): Promise<boolean> {
    const webview = this.webview;
    if (!webview) {
      return false;
    }
    return new Promise((resolve) => {
      const id = uuid();
      this.pendingCallbacks.set(id, (...args) => {
        resolve(args[0] as boolean);
      });
      webview.postMessage({ id, action: "checkFocused" });
    });
  }

  getApiVersions(): string[] | undefined {
    return Object.keys(this.client ?? {}).filter((key) => semver.valid(key));
  }

  get isTerminalContextEnabled(): boolean {
    return this.getApiVersions()?.some((version) => isCompatible(version, "0.10.0")) ?? false;
  }

  setActiveSelection(selection: EditorContext) {
    if (this.client) {
      this.logger.info(`Set active selection: ${selection}`);
      this.client["0.8.0"].updateActiveSelection(selection);
    } else {
      this.pendingActions.push(async () => {
        this.logger.info(`Set pending active selection: ${selection}`);
        await this.client?.["0.8.0"].updateActiveSelection(selection);
      });
    }
  }

  async addRelevantContext(context: EditorContext) {
    if (this.client) {
      this.logger.info(`Adding relevant context: ${context}`);
      if (context.kind === "terminal") {
        this.client["0.10.0"]?.addRelevantContext(context);
      } else {
        this.client["0.8.0"].addRelevantContext(context);
      }
    } else {
      this.pendingActions.push(async () => {
        this.logger.info(`Adding pending relevant context: ${context}`);
        if (context.kind === "terminal") {
          await this.client?.["0.10.0"]?.addRelevantContext(context);
        } else {
          await this.client?.["0.8.0"].addRelevantContext(context);
        }
      });
    }
  }

  async executeCommand(command: ChatCommand) {
    if (this.client) {
      this.logger.info(`Executing command: ${command}`);
      if (command === "explain-terminal") {
        this.client["0.10.0"]?.executeCommand(command);
      } else {
        this.client["0.8.0"].executeCommand(command);
      }
    } else {
      this.pendingActions.push(async () => {
        this.logger.info(`Executing pending command: ${command}`);
        if (command === "explain-terminal") {
          await this.client?.["0.10.0"]?.executeCommand(command);
        } else {
          await this.client?.["0.8.0"].executeCommand(command);
        }
      });
    }
  }

  async navigate(view: ChatView) {
    if (this.client) {
      this.logger.info(`Navigate: ${view}`);
      this.client["0.8.0"].navigate(view);
    }
  }

  private async initChatPanel(webview: Webview) {
    const client = await this.createChatPanelApiClient(webview);
    this.client = client;
    this.emit("didChangedStatus", "ready");

    if (this.createClientTimeout) {
      clearTimeout(this.createClientTimeout);
      this.createClientTimeout = undefined;
    }

    // 1. Send pending actions
    // 2. Call the client's init method
    // 3. Show the chat panel (call syncStyle underlay)
    this.pendingActions.forEach(async (fn) => {
      await fn();
    });
    this.pendingActions = [];

    const isMac = isBrowser
      ? navigator.userAgent.toLowerCase().includes("mac")
      : process.platform.toLowerCase().includes("darwin");

    await client["0.8.0"].init({
      fetcherOptions: {
        authorization: this.currentConfig?.token ?? "",
      },
      useMacOSKeyboardEventHandler: isMac,
    });

    webview.postMessage({ action: "showChatPanel" });
  }

  private async createChatPanelApiClient(webview: Webview): Promise<ServerApiList> {
    return await createClient(webview, {
      refresh: async () => {
        commands.executeCommand("tabby.reconnectToServer");
        return;
      },

      onApplyInEditor: async (content: string) => {
        const editor = window.activeTextEditor;
        if (!editor) {
          window.showErrorMessage("No active editor found.");
          return;
        }
        await this.applyInEditor(editor, content);
      },

      onApplyInEditorV2: async (content: string, options?: { languageId?: string; smart?: boolean }) => {
        const editor = window.activeTextEditor;
        if (!editor) {
          window.showErrorMessage("No active editor found.");
          return;
        }
        if (!options || !options.smart) {
          await this.applyInEditor(editor, content);
        } else if (editor.document.languageId !== options.languageId) {
          this.logger.debug("Editor's languageId:", editor.document.languageId, "opts.languageId:", options.languageId);
          await this.applyInEditor(editor, content);
          window.showInformationMessage("The active editor is not in the correct language. Did normal apply.");
        } else {
          await this.smartApplyInEditor(editor, content);
        }
      },

      onCopy: async (content) => {
        env.clipboard.writeText(content);
      },

      onKeyboardEvent: async (type: string, event: KeyboardEventInit) => {
        this.logger.debug(`Dispatching keyboard event: ${type} ${JSON.stringify(event)}`);
        this.webview?.postMessage({ action: "dispatchKeyboardEvent", type, event });
      },

      lookupSymbol: async (symbol: string, hints?: LookupSymbolHint[] | undefined): Promise<SymbolInfo | null> => {
        if (!symbol.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
          // Do not process invalid symbols
          return null;
        }
        /// FIXME: When no hints provided, try to use `vscode.executeWorkspaceSymbolProvider` to find the symbol.

        // Find the symbol in the hints
        for (const hint of hints ?? []) {
          if (!hint.filepath) {
            this.logger.debug("No filepath in the hint:", hint);
            continue;
          }
          const uri = chatPanelFilepathToLocalUri(hint.filepath, this.gitProvider);
          if (!uri) {
            continue;
          }

          let document: TextDocument;
          try {
            document = await workspace.openTextDocument(uri);
          } catch (error) {
            this.logger.debug("Failed to open document:", uri, error);
            continue;
          }
          if (!document) {
            continue;
          }

          const findSymbolInContent = async (
            content: string,
            offsetInDocument: number,
          ): Promise<SymbolInfo | undefined> => {
            // Add word boundary to perform exact match
            const matchRegExp = new RegExp(`\\b${symbol}\\b`, "g");
            let match;
            while ((match = matchRegExp.exec(content)) !== null) {
              const offset = offsetInDocument + match.index;
              const position = document.positionAt(offset);
              const locations = await commands.executeCommand<Location[] | LocationLink[]>(
                "vscode.executeDefinitionProvider",
                document.uri,
                position,
              );
              if (locations && locations.length > 0) {
                const location = locations[0];
                if (location) {
                  if ("targetUri" in location) {
                    const targetLocation = location.targetSelectionRange ?? location.targetRange;
                    return {
                      source: {
                        filepath: localUriToChatPanelFilepath(document.uri, this.gitProvider),
                        location: vscodePositionToChatPanelPosition(position),
                      },
                      target: {
                        filepath: localUriToChatPanelFilepath(location.targetUri, this.gitProvider),
                        location: vscodeRangeToChatPanelPositionRange(targetLocation),
                      },
                    };
                  } else if ("uri" in location) {
                    return {
                      source: {
                        filepath: localUriToChatPanelFilepath(document.uri, this.gitProvider),
                        location: vscodePositionToChatPanelPosition(position),
                      },
                      target: {
                        filepath: localUriToChatPanelFilepath(location.uri, this.gitProvider),
                        location: vscodeRangeToChatPanelPositionRange(location.range),
                      },
                    };
                  }
                }
              }
            }
            return undefined;
          };

          let symbolInfo: SymbolInfo | undefined;
          if (hint.location) {
            // Find in the hint location
            const location = chatPanelLocationToVSCodeRange(hint.location);
            if (location) {
              let range: Range;
              if (!location.isEmpty) {
                range = location;
              } else {
                // a empty range, create a new range with this line to the end of the file
                range = new Range(location.start.line, 0, document.lineCount, 0);
              }
              const content = document.getText(range);
              const offset = document.offsetAt(range.start);
              symbolInfo = await findSymbolInContent(content, offset);
            }
          }
          if (!symbolInfo) {
            // Fallback to find in full content
            const content = document.getText();
            symbolInfo = await findSymbolInContent(content, 0);
          }
          if (symbolInfo) {
            // Symbol found
            this.logger.debug(
              `Symbol found: ${symbol} with hints: ${JSON.stringify(hints)}: ${JSON.stringify(symbolInfo)}`,
            );
            return symbolInfo;
          }
        }
        this.logger.debug(`Symbol not found: ${symbol} with hints: ${JSON.stringify(hints)}`);
        return null;
      },

      openInEditor: async (fileLocation: FileLocation): Promise<boolean> => {
        const uri = chatPanelFilepathToLocalUri(fileLocation.filepath, this.gitProvider);
        if (!uri) {
          return false;
        }

        if (uri.scheme === "output") {
          try {
            await commands.executeCommand(`workbench.action.output.show.${uri.fsPath}`);
            return true;
          } catch (error) {
            this.logger.error("Failed to open output channel:", fileLocation, error);
            return false;
          }
        }

        const targetRange = chatPanelLocationToVSCodeRange(fileLocation.location) ?? new Range(0, 0, 0, 0);
        try {
          await commands.executeCommand(
            "editor.action.goToLocations",
            uri,
            targetRange.start,
            [new Location(uri, targetRange)],
            "goto",
          );
          return true;
        } catch (error) {
          this.logger.error("Failed to go to location:", fileLocation, error);
          return false;
        }
      },

      openExternal: async (url: string) => {
        await env.openExternal(Uri.parse(url));
      },

      readWorkspaceGitRepositories: async (): Promise<GitRepository[]> => {
        const activeTextEditor = window.activeTextEditor;
        const infoList: GitRepository[] = [];
        let activeGitUrl: string | undefined;
        if (activeTextEditor) {
          const repo = this.gitProvider.getRepository(activeTextEditor.document.uri);
          if (repo) {
            const gitRemoteUrl = this.gitProvider.getDefaultRemoteUrl(repo);
            if (gitRemoteUrl) {
              infoList.push({
                url: gitRemoteUrl,
              });
            }
          }
        }

        const workspaceFolder = workspace.workspaceFolders ?? [];
        for (const folder of workspaceFolder) {
          const repo = this.gitProvider.getRepository(folder.uri);
          if (repo) {
            const gitRemoteUrl = this.gitProvider.getDefaultRemoteUrl(repo);
            if (gitRemoteUrl && gitRemoteUrl !== activeGitUrl) {
              infoList.push({
                url: gitRemoteUrl,
              });
            }
          }
        }
        return infoList;
      },

      getActiveEditorSelection: async (): Promise<EditorFileContext | null> => {
        const editor = window.activeTextEditor;
        if (!editor || !isValidForSyncActiveEditorSelection(editor)) {
          return null;
        }

        return await getEditorContext(editor, this.gitProvider);
      },

      getActiveTerminalSelection: async (): Promise<TerminalContext | null> => {
        const terminalContext = await getTerminalContext();
        if (!terminalContext) {
          this.logger.warn("No active terminal selection found.");
          return null;
        }
        return terminalContext;
      },

      fetchSessionState: async (keys?: string[] | undefined): Promise<Record<string, unknown> | null> => {
        const sessionStateKey = this.currentConfig?.endpoint ?? "";
        const sessionState = this.sessionStateMap.get(sessionStateKey) ?? {};

        if (!keys) {
          return { ...sessionState };
        }

        const filtered: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in sessionState) {
            filtered[key] = sessionState[key];
          }
        }
        return filtered;
      },

      storeSessionState: async (state: Record<string, unknown>) => {
        const sessionStateKey = this.currentConfig?.endpoint ?? "";
        const sessionState = this.sessionStateMap.get(sessionStateKey) ?? {};
        this.sessionStateMap.set(sessionStateKey, {
          ...sessionState,
          ...state,
        });
      },

      listFileInWorkspace: async (params: ListFilesInWorkspaceParams): Promise<ListFileItem[]> => {
        try {
          const files = await this.listFiles(params.query, params.limit);
          return files.map((item) => {
            return {
              filepath: localUriToChatPanelFilepath(item.uri, this.gitProvider),
              source: item.isOpenedInEditor ? "openedInEditor" : "searchResult",
            };
          });
        } catch (error) {
          this.logger.warn("Failed to list files:", error);
          return [];
        }
      },

      readFileContent: async (info: FileRange): Promise<string | null> => {
        const uri = chatPanelFilepathToLocalUri(info.filepath, this.gitProvider);
        if (!uri) {
          this.logger.warn(`Could not resolve URI from filepath: ${JSON.stringify(info.filepath)}`);
          return null;
        }
        const document = await workspace.openTextDocument(uri);
        return document.getText(chatPanelLocationToVSCodeRange(info.range) ?? undefined);
      },
      listSymbols: async (params: ListSymbolsParams): Promise<ListSymbolItem[]> => {
        const { query } = params;
        let { limit } = params;
        const editor = window.activeTextEditor;

        if (!editor) {
          this.logger.warn("listActiveSymbols: No active editor found.");
          return [];
        }
        if (!limit || limit < 0) {
          limit = 20;
        }

        const getDocumentSymbols = async (editor: TextEditor): Promise<SymbolInformation[]> => {
          this.logger.debug(`getDocumentSymbols: Fetching document symbols for ${editor.document.uri.toString()}`);
          const symbols =
            (await commands.executeCommand<DocumentSymbol[] | SymbolInformation[]>(
              "vscode.executeDocumentSymbolProvider",
              editor.document.uri,
            )) || [];

          const result: SymbolInformation[] = [];
          const queue: (DocumentSymbol | SymbolInformation)[] = [...symbols];

          // BFS to get all symbols up to the limit
          while (queue.length > 0 && result.length < limit) {
            const current = queue.shift();
            if (!current) {
              continue;
            }

            if (current instanceof DocumentSymbol) {
              const converted = new SymbolInformation(
                current.name,
                current.kind,
                current.detail,
                new Location(editor.document.uri, current.range),
              );

              result.push(converted);

              if (result.length >= limit) {
                break;
              }

              queue.push(...current.children);
            } else {
              result.push(current);

              if (result.length >= limit) {
                break;
              }
            }
          }

          this.logger.debug(`getDocumentSymbols: Found ${result.length} symbols.`);
          return result;
        };

        const getWorkspaceSymbols = async (query: string): Promise<ListSymbolItem[]> => {
          this.logger.debug(`getWorkspaceSymbols: Fetching workspace symbols for query "${query}"`);
          try {
            const symbols =
              (await commands.executeCommand<SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query)) ||
              [];

            const items = symbols.map((symbol) => ({
              filepath: localUriToChatPanelFilepath(symbol.location.uri, this.gitProvider),
              range: vscodeRangeToChatPanelLineRange(symbol.location.range),
              label: symbol.name,
            }));
            this.logger.debug(`getWorkspaceSymbols: Found ${items.length} symbols.`);
            return items;
          } catch (error) {
            this.logger.error(`Workspace symbols failed: ${error}`);
            return [];
          }
        };

        const filterSymbols = (symbols: SymbolInformation[], query: string): SymbolInformation[] => {
          const lowerQuery = query.toLowerCase();
          const filtered = symbols.filter(
            (s) => s.name.toLowerCase().includes(lowerQuery) || s.containerName?.toLowerCase().includes(lowerQuery),
          );
          this.logger.debug(`filterSymbols: Filtered down to ${filtered.length} symbols with query "${query}"`);
          return filtered;
        };

        const mergeResults = (
          local: ListSymbolItem[],
          workspace: ListSymbolItem[],
          query: string,
          limit = 20,
        ): ListSymbolItem[] => {
          this.logger.debug(
            `mergeResults: Merging ${local.length} local symbols and ${workspace.length} workspace symbols with query "${query}" and limit ${limit}`,
          );

          const seen = new Set<string>();
          const allItems = [...local, ...workspace];
          const uniqueItems: ListSymbolItem[] = [];

          for (const item of allItems) {
            const key = `${item.filepath}-${item.label}-${item.range.start}-${item.range.end}`;
            if (!seen.has(key)) {
              seen.add(key);
              uniqueItems.push(item);
            }
          }

          // Sort all items by the match score
          const getMatchScore = (label: string): number => {
            const lowerLabel = label.toLowerCase();
            const lowerQuery = query.toLowerCase();

            if (lowerLabel === lowerQuery) return 3;
            if (lowerLabel.startsWith(lowerQuery)) return 2;
            if (lowerLabel.includes(lowerQuery)) return 1;
            return 0;
          };

          uniqueItems.sort((a, b) => {
            const scoreA = getMatchScore(a.label);
            const scoreB = getMatchScore(b.label);

            if (scoreB !== scoreA) return scoreB - scoreA;
            return a.label.length - b.label.length;
          });

          this.logger.debug(`mergeResults: Returning ${Math.min(uniqueItems.length, limit)} sorted symbols.`);
          return uniqueItems.slice(0, limit);
        };

        const symbolToItem = (symbol: SymbolInformation, filepath: Filepath): ListSymbolItem => {
          return {
            filepath,
            range: vscodeRangeToChatPanelLineRange(symbol.location.range),
            label: symbol.name,
          };
        };

        try {
          this.logger.info("listActiveSymbols: Starting to fetch symbols.");
          const defaultSymbols = await getDocumentSymbols(editor);
          const filepath = localUriToChatPanelFilepath(editor.document.uri, this.gitProvider);

          if (!query) {
            const items = defaultSymbols.slice(0, limit).map((symbol) => symbolToItem(symbol, filepath));
            this.logger.debug(`listActiveSymbols: Returning ${items.length} symbols.`);
            return items;
          }

          const [filteredDefault, workspaceSymbols] = await Promise.all([
            Promise.resolve(filterSymbols(defaultSymbols, query)),
            getWorkspaceSymbols(query),
          ]);
          this.logger.info(
            `listActiveSymbols: Found ${filteredDefault.length} filtered local symbols and ${workspaceSymbols.length} workspace symbols.`,
          );

          const mergedItems = mergeResults(
            filteredDefault.map((s) => symbolToItem(s, filepath)),
            workspaceSymbols,
            query,
            limit,
          );
          this.logger.info(`listActiveSymbols: Returning ${mergedItems.length} merged symbols.`);
          return mergedItems;
        } catch (error) {
          this.logger.error(`listActiveSymbols: Failed - ${error}`);
          return [];
        }
      },

      getChanges: async (params: GetChangesParams): Promise<ChangeItem[]> => {
        if (!this.gitProvider.isApiAvailable()) {
          return [];
        }

        const maxChars = params.maxChars ?? undefined;
        let remainingChars = maxChars;

        const repositories = this.gitProvider.getRepositories();
        if (!repositories) {
          return [];
        }

        const getRepoChanges = async (
          repos: Repository[],
          staged: boolean,
          charLimit?: number,
        ): Promise<ChangeItem[]> => {
          if (charLimit !== undefined && charLimit <= 0) {
            return [];
          }

          const res: ChangeItem[] = [];
          let currentCharCount = 0;

          for (const repo of repos) {
            const diffs = await this.gitProvider.getDiff(repo, staged);
            if (!diffs) {
              continue;
            }

            for (const diff of diffs) {
              const diffChars = diff.length;

              if (charLimit !== undefined && currentCharCount + diffChars > charLimit) {
                break;
              }

              res.push({
                content: diff,
                staged: staged,
              } as ChangeItem);

              currentCharCount += diffChars;
            }

            if (charLimit !== undefined && currentCharCount >= charLimit) {
              break;
            }
          }

          return res;
        };

        const stagedChanges: ChangeItem[] = await getRepoChanges(repositories, true, remainingChars);

        const stagedCharCount = stagedChanges.reduce((count, item) => count + item.content.length, 0);

        remainingChars = maxChars !== undefined ? maxChars - stagedCharCount : undefined;

        const unstagedChanges: ChangeItem[] = await getRepoChanges(repositories, false, remainingChars);

        const res = [...stagedChanges, ...unstagedChanges];

        this.logger.info(`Found ${res.length} changed files.`);

        return res;
      },
      runShell: async (command: string) => {
        const terminal = window.createTerminal("Tabby");
        terminal.show();
        terminal.sendText(command);
      },
    });
  }

  private checkStatusAndLoadContent() {
    const statusInfo = this.lspClient.status.current;
    const error = this.checkStatusInfo(statusInfo);
    if (error) {
      this.currentConfig = undefined;
      this.loadErrorPage(error);
      return;
    }
    const config = this.lspClient.agentConfig.current;
    if (!config) {
      this.currentConfig = undefined;
      this.loadErrorPage("Cannot get the server configuration.");
      return;
    }
    if (this.currentConfig?.endpoint !== config.server.endpoint || this.currentConfig?.token !== config.server.token) {
      this.currentConfig = config.server;
      this.loadChatPanel();
    }
  }

  private getUriStylesheet() {
    return (
      this.webview?.asWebviewUri(Uri.joinPath(this.context.extensionUri, "assets", "chat-panel.css")).toString() ?? ""
    );
  }

  private getUriAvatarTabby() {
    return this.webview?.asWebviewUri(Uri.joinPath(this.context.extensionUri, "assets", "tabby.png")).toString() ?? "";
  }

  private loadChatPanel() {
    const webview = this.webview;
    if (!webview) {
      return;
    }
    this.client = undefined;
    this.emit("didChangedStatus", "loading");
    this.reloadCount += 1;
    webview.html = mainHtml
      .replace(/{{RELOAD_COUNT}}/g, this.reloadCount.toString())
      .replace(/{{SERVER_ENDPOINT}}/g, this.currentConfig?.endpoint ?? "")
      .replace(/{{URI_STYLESHEET}}/g, this.getUriStylesheet())
      .replace(/{{URI_AVATAR_TABBY}}/g, this.getUriAvatarTabby());

    this.initChatPanel(webview);
  }

  private loadErrorPage(message: string) {
    const webview = this.webview;
    if (!webview) {
      return;
    }
    this.client = undefined;
    this.emit("didChangedStatus", "error");
    this.reloadCount += 1;
    webview.html = errorHtml
      .replace(/{{RELOAD_COUNT}}/g, this.reloadCount.toString())
      .replace(/{{URI_STYLESHEET}}/g, this.getUriStylesheet())
      .replace(/{{URI_AVATAR_TABBY}}/g, this.getUriAvatarTabby())
      .replace(/{{ERROR_MESSAGE}}/g, message);
  }

  // Returns undefined if no error, otherwise returns the error message
  private checkStatusInfo(statusInfo: StatusInfo | undefined): string | undefined {
    if (!statusInfo || statusInfo.status === "connecting") {
      return 'Connecting to the Tabby server...<br/><span class="loader"></span>';
    }

    if (statusInfo.status === "unauthorized") {
      return "Your token is invalid.<br/><a href='command:tabby.updateToken'><b>Update Token</b></a>";
    }

    if (statusInfo.status === "disconnected") {
      return "Failed to connect to the Tabby server.<br/><a href='command:tabby.connectToServer'><b>Connect To Server</b></a>";
    }

    const health = statusInfo.serverHealth;
    if (!health) {
      return "Cannot get the health status of the Tabby server.";
    }

    if (!health["webserver"] || !health["chat_model"]) {
      return "You need to launch the server with the chat model enabled; for example, use `--chat-model Qwen2-1.5B-Instruct`.";
    }

    const MIN_VERSION = "0.27.0";

    if (health["version"]) {
      let version: semver.SemVer | undefined | null = undefined;
      if (typeof health["version"] === "string") {
        version = semver.coerce(health["version"]);
      } else if (
        typeof health["version"] === "object" &&
        "git_describe" in health["version"] &&
        typeof health["version"]["git_describe"] === "string"
      ) {
        version = semver.coerce(health["version"]["git_describe"]);
      }
      if (version && semver.lt(version, MIN_VERSION)) {
        return `Tabby Chat requires Tabby server version ${MIN_VERSION} or later. Your server is running version ${version}.`;
      }
    }

    return undefined;
  }

  private async applyInEditor(editor: TextEditor, content: string) {
    const document = editor.document;
    const selection = editor.selection;

    // Determine the indentation for the content
    // The calculation is based solely on the indentation of the first line
    const lineText = document.lineAt(selection.start.line).text;
    const match = lineText.match(/^(\s*)/);
    const indent = match ? match[0] : "";

    // Determine the indentation for the content's first line
    // Note:
    // If using spaces, selection.start.character = 1 means 1 space
    // If using tabs, selection.start.character = 1 means 1 tab
    const indentUnit = indent[0];
    const indentAmountForTheFirstLine = Math.max(indent.length - selection.start.character, 0);
    const indentForTheFirstLine = indentUnit?.repeat(indentAmountForTheFirstLine) ?? "";
    // Indent the content
    const indentedContent = indentForTheFirstLine + content.replaceAll("\n", "\n" + indent);

    // Apply into the editor
    await editor.edit((editBuilder) => {
      editBuilder.replace(selection, indentedContent);
    });
  }

  private async smartApplyInEditor(editor: TextEditor, content: string) {
    this.logger.info("Smart apply in editor started.");
    this.logger.trace("Smart apply in editor with content:", { content });

    window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: "Smart Apply in Progress",
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 0, message: "Applying smart edit..." });
        try {
          await this.lspClient.chat.provideSmartApplyEdit(
            {
              text: content,
              location: {
                uri: editor.document.uri.toString(),
                range: {
                  start: { line: editor.selection.start.line, character: editor.selection.start.character },
                  end: { line: editor.selection.end.line, character: editor.selection.end.character },
                },
              },
            },
            token,
          );
        } catch (error) {
          if (error instanceof Error) {
            window.showErrorMessage(error.message);
          } else {
            window.showErrorMessage("An unknown error occurred");
          }
        }
      },
    );
  }

  private async notifyActiveEditorSelectionChange(editor: TextEditor | undefined) {
    if (editor && editor.document.uri.scheme === "output") {
      // do not update when the active editor is an output channel
      return;
    }

    if (!editor || !isValidForSyncActiveEditorSelection(editor)) {
      await this.client?.["0.8.0"].updateActiveSelection(null);
      return;
    }

    const fileContext = await getEditorContext(editor, this.gitProvider);
    await this.client?.["0.8.0"].updateActiveSelection(fileContext);
  }

  private debouncedNotifyActiveEditorSelectionChange = debounce(async (editor: TextEditor | undefined) => {
    await this.notifyActiveEditorSelectionChange(editor);
  }, 100);

  private listFiles = wrapCancelableFunction(
    listFiles,
    (args) => args[2],
    (args, token) => {
      args[2] = token;
      return args;
    },
  );

  private getColorThemeString() {
    switch (window.activeColorTheme.kind) {
      case ColorThemeKind.Light:
      case ColorThemeKind.HighContrastLight:
        return "light";
      case ColorThemeKind.Dark:
      case ColorThemeKind.HighContrast:
        return "dark";
    }
  }
}
