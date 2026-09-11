export interface SerializableEditCommand {
  id: string;
  label: string;
  kind:
    | "patch"
    | "duplicate-object"
    | "delete-object"
    | "reorder-slide"
    | "duplicate-slide"
    | "delete-slide";
  targetId: string;
  before: unknown;
  after: unknown;
}

export interface CommandExecutor {
  apply(
    command: SerializableEditCommand,
    direction: "before" | "after",
    transition: "execute" | "undo" | "redo",
  ): Promise<SerializableEditCommand | void>;
}

export interface HistorySnapshot {
  commands: SerializableEditCommand[];
  canUndo: boolean;
  canRedo: boolean;
  size: number;
  cursor: number;
}

export class HistoryBusyError extends Error {
  constructor() {
    super("Cannot restore history while a transition is pending");
    this.name = "HistoryBusyError";
  }
}

export class CommandHistory {
  private commands: SerializableEditCommand[] = [];
  private cursor = 0;
  private transitionTail: Promise<void> = Promise.resolve();
  private pendingTransitions = 0;

  constructor(private readonly executor: CommandExecutor) {}

  async execute(command: SerializableEditCommand): Promise<void> {
    const storedCommand = cloneCommand(command);
    await this.enqueueTransition(async () => {
      const acknowledged = await this.executor.apply(
        cloneCommand(storedCommand),
        "after",
        "execute",
      );
      const committedCommand = acknowledged
        ? cloneCommand(acknowledged)
        : storedCommand;

      this.commands.splice(this.cursor);
      this.commands.push(committedCommand);
      this.cursor = this.commands.length;
    });
  }

  async undo(): Promise<void> {
    await this.enqueueTransition(async () => {
      if (this.cursor === 0) return;

      const command = this.commands[this.cursor - 1];
      await this.executor.apply(cloneCommand(command), "before", "undo");
      this.cursor -= 1;
    });
  }

  async redo(): Promise<void> {
    await this.enqueueTransition(async () => {
      if (this.cursor === this.commands.length) return;

      const command = this.commands[this.cursor];
      await this.executor.apply(cloneCommand(command), "after", "redo");
      this.cursor += 1;
    });
  }

  restore(commands: SerializableEditCommand[], cursor: number): void {
    if (this.pendingTransitions > 0) {
      throw new HistoryBusyError();
    }

    if (!Number.isInteger(cursor) || cursor < 0 || cursor > commands.length) {
      throw new RangeError("History cursor must be within the command list");
    }

    const restoredCommands = commands.map(cloneCommand);
    this.commands = restoredCommands;
    this.cursor = cursor;
  }

  snapshot(): HistorySnapshot {
    return {
      commands: this.commands.map(cloneCommand),
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.commands.length,
      size: this.commands.length,
      cursor: this.cursor,
    };
  }

  private enqueueTransition(operation: () => Promise<void>): Promise<void> {
    this.pendingTransitions += 1;
    const result = this.transitionTail.then(operation);
    this.transitionTail = result.then(
      () => {
        this.pendingTransitions -= 1;
      },
      () => {
        this.pendingTransitions -= 1;
      },
    );
    return result;
  }
}

function cloneCommand(
  command: SerializableEditCommand,
): SerializableEditCommand {
  assertJsonSerializable(command);
  return structuredClone(command);
}

function assertJsonSerializable(
  value: unknown,
  ancestors = new Set<object>(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Command descriptors require finite numbers");
    }
    return;
  }

  if (typeof value !== "object") {
    throw new TypeError("Command descriptors must contain JSON data only");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Command descriptors cannot contain circular data");
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError("Command descriptors must contain plain JSON objects");
  }

  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonSerializable(item, ancestors);
  }
  ancestors.delete(value);
}
