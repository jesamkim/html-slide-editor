import { describe, expect, it, vi } from "vitest";
import {
  CommandHistory,
  type SerializableEditCommand,
} from "./commandHistory";

const moveCommand = (): SerializableEditCommand => ({
  id: "move-1",
  label: "Move object",
  kind: "patch",
  targetId: "node-1",
  before: { translateX: 0, translateY: 0 },
  after: { translateX: 10, translateY: 0 },
});

const colorCommand = (): SerializableEditCommand => ({
  id: "color-1",
  label: "Change color",
  kind: "patch",
  targetId: "node-1",
  before: { color: "#000" },
  after: { color: "#fff" },
});

const deferred = () => {
  let resolve = () => {};
  let reject = (_reason?: unknown) => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};

describe("CommandHistory", () => {
  it("stores the exact command returned by an acknowledged apply", async () => {
    const acknowledged: SerializableEditCommand = {
      id: "duplicate-1",
      label: "Duplicate object",
      kind: "duplicate-object",
      targetId: "copy-1",
      before: null,
      after: {
        parentId: "parent-1",
        index: 2,
        html: '<div data-hse-id="copy-1">Copy</div>',
      },
    };
    const history = new CommandHistory({
      apply: vi.fn().mockResolvedValue(acknowledged),
    });

    await history.execute({
      ...acknowledged,
      targetId: "source-1",
      after: null,
    });

    expect(history.snapshot().commands).toEqual([acknowledged]);
  });

  it("executes, undoes, and redoes one command", async () => {
    const apply = vi.fn();
    const history = new CommandHistory({ apply });
    const command = moveCommand();

    await history.execute(command);
    expect(apply).toHaveBeenLastCalledWith(command, "after", "execute");

    await history.undo();
    expect(apply).toHaveBeenLastCalledWith(command, "before", "undo");

    await history.redo();
    expect(apply).toHaveBeenLastCalledWith(command, "after", "redo");
    expect(history.snapshot()).toMatchObject({
      canUndo: true,
      canRedo: false,
      size: 1,
      cursor: 1,
    });
  });

  it("does not record a command whose apply operation fails", async () => {
    const history = new CommandHistory({
      apply: vi.fn().mockRejectedValue(new Error("failed")),
    });

    await expect(history.execute(colorCommand())).rejects.toThrow("failed");

    expect(history.snapshot()).toEqual({
      commands: [],
      canUndo: false,
      canRedo: false,
      size: 0,
      cursor: 0,
    });
  });

  it("keeps the cursor unchanged when undo fails", async () => {
    const apply = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("undo failed"));
    const history = new CommandHistory({ apply });
    await history.execute(moveCommand());

    await expect(history.undo()).rejects.toThrow("undo failed");

    expect(history.snapshot()).toMatchObject({
      canUndo: true,
      canRedo: false,
      size: 1,
      cursor: 1,
    });
  });

  it("keeps the cursor unchanged when redo fails", async () => {
    const apply = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("redo failed"));
    const history = new CommandHistory({ apply });
    await history.execute(moveCommand());
    await history.undo();

    await expect(history.redo()).rejects.toThrow("redo failed");

    expect(history.snapshot()).toMatchObject({
      canUndo: false,
      canRedo: true,
      size: 1,
      cursor: 0,
    });
  });

  it("truncates the redo branch after a successful new execute", async () => {
    const history = new CommandHistory({ apply: vi.fn() });
    await history.execute(moveCommand());
    await history.execute(colorCommand());
    await history.undo();

    const replacement: SerializableEditCommand = {
      id: "delete-1",
      label: "Delete object",
      kind: "delete-object",
      targetId: "node-2",
      before: { html: "<p>Removed</p>", index: 1 },
      after: null,
    };
    await history.execute(replacement);

    expect(history.snapshot()).toEqual({
      commands: [moveCommand(), replacement],
      canUndo: true,
      canRedo: false,
      size: 2,
      cursor: 2,
    });
  });

  it("preserves the redo branch when a new execute fails", async () => {
    const apply = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("replacement failed"));
    const history = new CommandHistory({ apply });
    await history.execute(moveCommand());
    await history.execute(colorCommand());
    await history.undo();

    await expect(
      history.execute({
        id: "bad-replacement",
        label: "Bad replacement",
        kind: "delete-object",
        targetId: "node-2",
        before: { html: "<p>Removed</p>", index: 1 },
        after: null,
      }),
    ).rejects.toThrow("replacement failed");

    expect(history.snapshot()).toEqual({
      commands: [moveCommand(), colorCommand()],
      canUndo: true,
      canRedo: true,
      size: 2,
      cursor: 1,
    });
  });

  it("restores a JSON-round-tripped snapshot at its cursor", async () => {
    const source = new CommandHistory({ apply: vi.fn() });
    await source.execute(moveCommand());
    await source.execute(colorCommand());
    await source.undo();
    const persisted = JSON.parse(
      JSON.stringify(source.snapshot()),
    ) as ReturnType<CommandHistory["snapshot"]>;

    const restored = new CommandHistory({ apply: vi.fn() });
    restored.restore(persisted.commands, persisted.cursor);

    expect(restored.snapshot()).toEqual(persisted);
  });

  it.each([-1, 1, 1.5, Number.NaN])(
    "rejects restore cursor %s for an empty command list",
    (cursor) => {
      const history = new CommandHistory({ apply: vi.fn() });

      expect(() => history.restore([], cursor)).toThrowError(RangeError);
      expect(history.snapshot()).toMatchObject({ size: 0, cursor: 0 });
    },
  );

  it("isolates executed commands from caller and executor mutations", async () => {
    const command = moveCommand();
    const history = new CommandHistory({
      apply: vi.fn(async (applied) => {
        (applied.after as { translateX: number }).translateX = 999;
      }),
    });

    await history.execute(command);
    (command.before as { translateX: number }).translateX = -999;

    expect(history.snapshot().commands).toEqual([moveCommand()]);
  });

  it("isolates restored commands and returned snapshots from mutation", () => {
    const commands = [moveCommand()];
    const history = new CommandHistory({ apply: vi.fn() });
    history.restore(commands, 1);

    (commands[0].after as { translateX: number }).translateX = 999;
    const firstSnapshot = history.snapshot();
    (firstSnapshot.commands[0].before as { translateX: number }).translateX =
      -999;

    expect(history.snapshot().commands).toEqual([moveCommand()]);
  });

  it("rejects closure-bearing descriptors without applying or recording them", async () => {
    const apply = vi.fn();
    const history = new CommandHistory({ apply });
    const invalid = {
      ...moveCommand(),
      after: { run: () => "not serializable" },
    } as unknown as SerializableEditCommand;

    await expect(history.execute(invalid)).rejects.toThrow();

    expect(apply).not.toHaveBeenCalled();
    expect(history.snapshot()).toMatchObject({ size: 0, cursor: 0 });
  });

  it("serializes overlapping undo calls without moving before the start", async () => {
    const firstApply = deferred();
    const secondApply = deferred();
    const applied: string[] = [];
    const history = new CommandHistory({
      apply: vi.fn((command, direction) => {
        applied.push(`${command.id}:${direction}`);
        return applied.length === 1 ? firstApply.promise : secondApply.promise;
      }),
    });
    history.restore([moveCommand()], 1);

    const firstUndo = history.undo();
    const secondUndo = history.undo();
    await Promise.resolve();
    const appliedBeforeSettlement = [...applied];

    firstApply.resolve();
    secondApply.resolve();
    await Promise.all([firstUndo, secondUndo]);

    expect(appliedBeforeSettlement).toEqual(["move-1:before"]);
    expect(applied).toEqual(["move-1:before"]);
    expect(history.snapshot()).toMatchObject({
      canUndo: false,
      canRedo: true,
      size: 1,
      cursor: 0,
    });
  });

  it("serializes overlapping redo calls without moving past the end", async () => {
    const firstApply = deferred();
    const secondApply = deferred();
    const applied: string[] = [];
    const history = new CommandHistory({
      apply: vi.fn((command, direction) => {
        applied.push(`${command.id}:${direction}`);
        return applied.length === 1 ? firstApply.promise : secondApply.promise;
      }),
    });
    history.restore([moveCommand()], 0);

    const firstRedo = history.redo();
    const secondRedo = history.redo();
    await Promise.resolve();
    const appliedBeforeSettlement = [...applied];

    firstApply.resolve();
    secondApply.resolve();
    await Promise.all([firstRedo, secondRedo]);

    expect(appliedBeforeSettlement).toEqual(["move-1:after"]);
    expect(applied).toEqual(["move-1:after"]);
    expect(history.snapshot()).toMatchObject({
      canUndo: true,
      canRedo: false,
      size: 1,
      cursor: 1,
    });
  });

  it("commits overlapping execute calls in invocation order", async () => {
    const firstApply = deferred();
    const secondApply = deferred();
    const applied: SerializableEditCommand[] = [];
    const history = new CommandHistory({
      apply: vi.fn((command) => {
        applied.push(command);
        return command.id === "move-1"
          ? firstApply.promise
          : secondApply.promise;
      }),
    });
    const secondCommand = colorCommand();

    const firstExecute = history.execute(moveCommand());
    const secondExecute = history.execute(secondCommand);
    (secondCommand.after as { color: string }).color = "#f00";
    await Promise.resolve();
    const appliedBeforeSettlement = structuredClone(applied);

    secondApply.resolve();
    firstApply.resolve();
    await Promise.all([firstExecute, secondExecute]);

    expect(appliedBeforeSettlement).toEqual([moveCommand()]);
    expect(applied).toEqual([moveCommand(), colorCommand()]);
    expect(history.snapshot()).toEqual({
      commands: [moveCommand(), colorCommand()],
      canUndo: true,
      canRedo: false,
      size: 2,
      cursor: 2,
    });
  });

  it("continues queued transitions after an earlier operation rejects", async () => {
    const failedApply = deferred();
    const applied: string[] = [];
    const history = new CommandHistory({
      apply: vi.fn((command) => {
        applied.push(command.id);
        return command.id === "move-1"
          ? failedApply.promise
          : Promise.resolve();
      }),
    });

    const failedExecute = history.execute(moveCommand());
    const failedExpectation = expect(failedExecute).rejects.toThrow(
      "apply failed",
    );
    const successfulExecute = history.execute(colorCommand());
    await Promise.resolve();
    const appliedBeforeRejection = [...applied];

    failedApply.reject(new Error("apply failed"));
    await failedExpectation;
    await successfulExecute;

    expect(appliedBeforeRejection).toEqual(["move-1"]);
    expect(applied).toEqual(["move-1", "color-1"]);
    expect(history.snapshot()).toEqual({
      commands: [colorCommand()],
      canUndo: true,
      canRedo: false,
      size: 1,
      cursor: 1,
    });
  });

  it("marks restore busy only while a transition is pending", async () => {
    const applyGate = deferred();
    const history = new CommandHistory({
      apply: vi.fn(() => applyGate.promise),
    });

    const execute = history.execute(moveCommand());
    await Promise.resolve();
    let busyError: unknown;
    try {
      history.restore([colorCommand()], 1);
    } catch (error) {
      busyError = error;
    }

    applyGate.resolve();
    await execute;
    history.restore([colorCommand()], 1);

    expect(busyError).toMatchObject({
      name: "HistoryBusyError",
      message: "Cannot restore history while a transition is pending",
    });
    expect(history.snapshot().commands).toEqual([colorCommand()]);
  });
});
