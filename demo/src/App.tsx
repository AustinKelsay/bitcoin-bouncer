import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eraser,
  FlaskConical,
  Pencil,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./App.css";
import {
  filterRunEvents,
  type RunLogActionFilter,
} from "./run-log-filters";

const API_BASE_URL = import.meta.env.VITE_BOUNCER_API_URL ?? "";

type HealthResponse = {
  status: string;
  prompt?: string;
  promptHash?: string;
  gateNode?: string;
  propagationWitnesses: string[];
};

type SavePromptResponse = {
  status: "saved";
  prompt: string;
  promptHash: string;
  activePromptHash?: string;
};

type AuditEvent = {
  txid: string;
  outcome: string;
  responseBody: unknown;
  promptHash?: string;
};

type Hold = {
  holdId: string;
  txid: string;
  status: "held" | "released" | "discarded";
  reason: string;
};

type RunEvent = {
  id: number;
  runId: string;
  source: "smoke" | "fuzz" | "propagation";
  name: string;
  status: "running" | "passed" | "failed" | "skipped";
  detail?: unknown;
  createdAt: string;
};

type DashboardData = {
  health?: HealthResponse;
  auditEvents: AuditEvent[];
  holds: Hold[];
  runEvents: RunEvent[];
};

type LoadState =
  | { status: "loading"; data?: DashboardData; error?: undefined }
  | { status: "ready"; data: DashboardData; error?: undefined }
  | { status: "error"; data?: DashboardData; error: string };

type DemoRunKind = "smoke" | "forced_actions" | "model_compliance" | "fuzz";

const outcomeLabels: Record<string, string> = {
  pass: "Passed to Gate Node",
  tag: "Tagged and passed",
  hold: "Held for review",
  drop: "Dropped",
  shadow_drop: "Shadow dropped",
  preflight_reject: "Rejected by preflight",
  gate_submission_failure: "Gate submission failed",
  queue_full_pass: "Passed because queue was full",
  hold_queue_full_pass: "Passed because hold queue was full",
};

function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | undefined>();
  const [triggeringRun, setTriggeringRun] = useState<DemoRunKind | undefined>();
  const [savedPromptHash, setSavedPromptHash] = useState<string | undefined>();
  const [savingPrompt, setSavingPrompt] = useState(false);

  const refreshDashboard = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!options.quiet) {
      setLoadState((current) => ({ status: "loading", data: current.data }));
    }

    try {
      const [health, audit, holds, runEvents] = await Promise.all([
        fetchJson<HealthResponse>("/v1/health"),
        fetchJson<{ events: AuditEvent[] }>("/v1/audit"),
        fetchJson<{ holds: Hold[] }>("/v1/holds"),
        fetchJson<{ events: RunEvent[] }>("/v1/demo/events"),
      ]);

      setLoadState({
        status: "ready",
        data: {
          health,
          auditEvents: audit.events,
          holds: holds.holds,
          runEvents: runEvents.events,
        },
      });
      setLastUpdatedAt(new Date());
    } catch (error) {
      setLoadState((current) => ({
        status: "error",
        data: current.data,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  useEffect(() => {
    void refreshDashboard();
    const interval = window.setInterval(() => {
      void refreshDashboard({ quiet: true });
    }, 15_000);

    return () => window.clearInterval(interval);
  }, [refreshDashboard]);

  useEffect(() => {
    const events = new EventSource(`${API_BASE_URL}/v1/demo/events/stream`);

    events.addEventListener("run-event", (event) => {
      const runEvent = parseRunEvent((event as MessageEvent).data);

      if (!runEvent) {
        return;
      }

      setLoadState((current) => {
        if (!current.data) {
          return current;
        }

        return {
          ...current,
          data: {
            ...current.data,
            runEvents: mergeRunEvents(current.data.runEvents, runEvent),
          },
        };
      });
      setLastUpdatedAt(new Date());
    });

    return () => events.close();
  }, []);

  const data = loadState.data ?? {
    auditEvents: [],
    holds: [],
    runEvents: [],
  };
  const health = data.health;
  const latestAuditEvent = data.auditEvents.at(-1);
  const latestRunEvent = data.runEvents.at(-1);
  const latestPropagationEvent = data.runEvents
    .filter((event) => event.source === "propagation")
    .at(-1);
  const latestFuzzEvent = data.runEvents
    .filter((event) => event.name.includes("Fuzz Candidate"))
    .at(-1);
  const observedPromptHealth = latestObservedPromptHealth(data.runEvents) ?? health;
  const activeHolds = data.holds.filter((hold) => hold.status === "held");
  const hasRunningRun = hasActiveRun(data.runEvents);

  async function clearLogs() {
    try {
      await fetchJson("/v1/demo/events", {
        method: "DELETE",
      });
      setLoadState((current) => {
        if (!current.data) {
          return current;
        }

        return {
          ...current,
          data: {
            ...current.data,
            runEvents: [],
          },
        };
      });
      setLastUpdatedAt(new Date());
    } catch (error) {
      setLoadState((current) => ({
        status: "error",
        data: current.data,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function startRun(kind: DemoRunKind) {
    setTriggeringRun(kind);

    try {
      await fetchJson("/v1/demo/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      await refreshDashboard({ quiet: true });
    } catch (error) {
      setLoadState((current) => ({
        status: "error",
        data: current.data,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setTriggeringRun(undefined);
    }
  }

  async function savePrompt(prompt: string) {
    setSavingPrompt(true);

    try {
      const saved = await fetchJson<SavePromptResponse>("/v1/prompt", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      setSavedPromptHash(saved.promptHash);
      setLoadState((current) => {
        if (!current.data?.health) {
          return current;
        }

        return {
          ...current,
          data: {
            ...current.data,
            health: {
              ...current.data.health,
              prompt: saved.prompt,
              promptHash: saved.activePromptHash ?? saved.promptHash,
            },
          },
        };
      });
      setLastUpdatedAt(new Date());
    } catch (error) {
      setLoadState((current) => ({
        status: "error",
        data: current.data,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setSavingPrompt(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground antialiased">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-lg bg-card/70 p-4 shadow-surface sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-accent">
              <Activity className="size-4" />
              Bitcoin Bouncer demo
            </p>
            <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
              Live smoke run
            </h1>
            <p className="mt-1 max-w-2xl text-pretty text-sm text-muted-foreground">
              See the current prompt, the latest candidate decision, and whether the transaction reached the witness nodes.
            </p>
          </div>
          <button
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-secondary px-3 text-sm font-medium text-secondary-foreground shadow-button transition-transform duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loadState.status === "loading"}
            type="button"
            onClick={() => void refreshDashboard()}
          >
            <RefreshCw className={loadState.status === "loading" ? "size-4 animate-spin" : "size-4"} />
            Refresh
          </button>
        </header>

        {loadState.status === "error" ? (
          <div className="flex items-start gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-destructive shadow-surface">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Bouncer Runtime is offline.</p>
              <p className="text-pretty opacity-90">{loadState.error}</p>
            </div>
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Signal label="Runtime" value={health?.status ?? "offline"} />
          <Signal label="Gate Node" value={health?.gateNode ?? "not reported"} />
          <Signal
            label="Witnesses"
            value={health?.propagationWitnesses.length ? health.propagationWitnesses.join(", ") : "none"}
          />
          <Signal
            label="Last Update"
            value={lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString() : "never"}
          />
        </section>

        <RunControls
          disabled={Boolean(triggeringRun) || hasRunningRun}
          triggeringRun={triggeringRun}
          onClear={() => void clearLogs()}
          onStart={(kind) => void startRun(kind)}
        />

        <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <PromptPanel
            key={observedPromptHealth?.promptHash ?? "no-prompt"}
            health={observedPromptHealth}
            savedPromptHash={savedPromptHash}
            saving={savingPrompt}
            onSave={(prompt) => void savePrompt(prompt)}
          />
          <div className="grid gap-4">
            <DecisionPanel event={latestAuditEvent} fuzzEvent={latestFuzzEvent} holds={activeHolds} />
            <PropagationPanel event={latestPropagationEvent} />
          </div>
        </section>

        <RunLog events={data.runEvents} latestEvent={latestRunEvent} />
      </div>
    </main>
  );
}

function RunControls({
  disabled,
  triggeringRun,
  onClear,
  onStart,
}: {
  disabled: boolean;
  triggeringRun?: DemoRunKind;
  onClear: () => void;
  onStart: (kind: DemoRunKind) => void;
}) {
  return (
    <section className="grid gap-2 sm:grid-cols-5">
      <RunButton
        disabled={disabled}
        isStarting={triggeringRun === "smoke"}
        label="Smoke"
        onClick={() => onStart("smoke")}
      />
      <RunButton
        disabled={disabled}
        isStarting={triggeringRun === "forced_actions"}
        label="Forced Actions"
        onClick={() => onStart("forced_actions")}
      />
      <RunButton
        disabled={disabled}
        isStarting={triggeringRun === "model_compliance"}
        label="Model Check"
        onClick={() => onStart("model_compliance")}
      />
      <RunButton
        disabled={disabled}
        isStarting={triggeringRun === "fuzz"}
        label="Fuzz"
        onClick={() => onStart("fuzz")}
      />
      <button
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-secondary px-3 text-sm font-medium text-secondary-foreground shadow-button transition-transform duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        type="button"
        onClick={onClear}
      >
        <Eraser className="size-4" />
        Clear Logs
      </button>
    </section>
  );
}

function RunButton({
  disabled,
  isStarting,
  label,
  onClick,
}: {
  disabled: boolean;
  isStarting: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-button transition-transform duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      {isStarting ? <RefreshCw className="size-4 animate-spin" /> : <Play className="size-4" />}
      {label}
    </button>
  );
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-card p-3 shadow-surface">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function PromptPanel({
  health,
  savedPromptHash,
  saving,
  onSave,
}: {
  health?: HealthResponse;
  savedPromptHash?: string;
  saving: boolean;
  onSave: (prompt: string) => void;
}) {
  const activePrompt =
    health?.prompt?.trimEnd() || "Prompt unavailable until the Bouncer Runtime is online.";
  const [isEditing, setIsEditing] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(activePrompt);

  return (
    <section className="rounded-lg bg-card p-4 shadow-surface">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-balance text-base font-semibold">Current prompt</h2>
          <p className="text-pretty text-sm text-muted-foreground">
            The Live Agent prompt loaded by this Bouncer Runtime.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Pill>{health?.promptHash ? shortHash(health.promptHash) : "no hash"}</Pill>
          <button
            aria-label={isEditing ? "Cancel prompt edit" : "Edit prompt"}
            className="inline-flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground shadow-button transition-transform duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!health?.prompt}
            type="button"
            onClick={() => {
              if (isEditing) {
                setDraftPrompt(activePrompt);
              }
              setIsEditing(!isEditing);
            }}
          >
            {isEditing ? <X className="size-4" /> : <Pencil className="size-4" />}
          </button>
        </div>
      </div>
      {isEditing ? (
        <div className="mt-4 grid gap-3">
          <textarea
            className="min-h-[24rem] w-full resize-y rounded-md border border-border bg-background/70 p-3 font-mono text-xs leading-5 text-foreground outline-none transition-colors focus:border-accent"
            value={draftPrompt}
            onChange={(event) => setDraftPrompt(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Saved edits update the prompt file and the next Live Agent decision immediately.
            </p>
            <button
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-button transition-transform duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={saving || !draftPrompt.trim()}
              type="button"
              onClick={() => {
                onSave(`${draftPrompt.trimEnd()}\n`);
                setIsEditing(false);
              }}
            >
              {saving ? <RefreshCw className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save Prompt
            </button>
          </div>
        </div>
      ) : (
        <pre className="mt-4 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-3 text-xs leading-5 text-muted-foreground">
          {activePrompt}
        </pre>
      )}
      {savedPromptHash && savedPromptHash === health?.promptHash ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-accent/10 px-3 py-2 text-xs text-accent">
          <Check className="size-4" />
          <span>Active now</span>
          <span className="text-muted-foreground">{shortHash(savedPromptHash)}</span>
        </div>
      ) : null}
    </section>
  );
}

function DecisionPanel({
  event,
  fuzzEvent,
  holds,
}: {
  event?: AuditEvent;
  fuzzEvent?: RunEvent;
  holds: Hold[];
}) {
  const txid = event?.txid ?? extractTxidFromRunEvent(fuzzEvent);
  const outcome = event ? outcomeLabels[event.outcome] ?? titleCase(event.outcome) : "No decision yet";
  const responseSummary = event ? summarizeResponse(event.responseBody) : summarizeRunEventDetail(fuzzEvent?.detail);

  return (
    <section className="rounded-lg bg-card p-4 shadow-surface">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-balance text-base font-semibold">Latest candidate</h2>
          <p className="text-pretty text-sm text-muted-foreground">
            What Bouncer decided for the newest transaction.
          </p>
        </div>
        <ShieldCheck className="size-5 text-accent" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Signal label="Decision" value={outcome} />
        <Signal label="Txid" value={txid ? shortHash(txid) : "waiting"} />
        <Signal label="Held" value={`${holds.length} active`} />
      </div>
      <p className="mt-3 truncate rounded-md bg-secondary/60 px-3 py-2 text-sm text-muted-foreground">
        {responseSummary}
      </p>
    </section>
  );
}

function PropagationPanel({ event }: { event?: RunEvent }) {
  const detail = readPropagationDetail(event?.detail);

  return (
    <section className="rounded-lg bg-card p-4 shadow-surface">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-balance text-base font-semibold">Propagation check</h2>
          <p className="text-pretty text-sm text-muted-foreground">
            Whether the Gate Node and witnesses saw the candidate.
          </p>
        </div>
        <RadioTower className="size-5 text-accent" />
      </div>
      {detail ? (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Pill>{detail.expected === "present" ? "should propagate" : "should stay absent"}</Pill>
            <Pill>{detail.passed ? "passed" : "failed"}</Pill>
            <span className="text-xs text-muted-foreground tabular-nums">{shortHash(detail.txid)}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {detail.nodes.map((node) => (
              <div className="rounded-md bg-secondary/60 p-3" key={node.name}>
                <p className="text-sm font-medium">{node.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {node.visible ? "visible in mempool" : "not visible"} · {node.passed ? "ok" : "mismatch"}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-4 rounded-md bg-secondary/60 px-3 py-3 text-sm text-muted-foreground">
          Waiting for propagation verification.
        </p>
      )}
    </section>
  );
}

function RunLog({
  events,
  latestEvent,
}: {
  events: RunEvent[];
  latestEvent?: RunEvent;
}) {
  const [actionFilter, setActionFilter] = useState<RunLogActionFilter>("all");
  const filteredEvents = filterRunEvents(events, actionFilter);
  const visibleEvents = [...filteredEvents].reverse();

  return (
    <section className="rounded-lg bg-card p-4 shadow-surface">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-balance text-base font-semibold">Run log</h2>
          <p className="text-pretty text-sm text-muted-foreground">
            The smoke/fuzz script steps as they happen.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunLogFilterControl value={actionFilter} onChange={setActionFilter} />
          <Pill>{latestEvent?.status ?? "waiting"}</Pill>
        </div>
      </div>
      <div className="mt-4 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
        {visibleEvents.length ? (
          visibleEvents.map((event) => (
            <article
              className={`grid gap-3 rounded-md bg-secondary/60 p-3 shadow-button transition-colors duration-150 hover:bg-secondary/80 sm:grid-cols-[150px_minmax(0,1fr)_86px] ${runEventToneClass(event)}`}
              key={event.id}
            >
              <div className="flex min-w-0 items-center gap-2">
                <RunEventIcon source={event.source} status={event.status} />
                <Pill tone={runEventPillTone(event)}>{runEventActor(event)}</Pill>
              </div>
              <div className="min-w-0">
                <p className="text-pretty text-sm font-medium leading-5">
                  {event.name}
                  <span className="ml-2 whitespace-nowrap text-xs font-normal text-muted-foreground">
                    {shortRunId(event.runId)}
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground">{summarizeRunEventDetail(event.detail)}</p>
                <RunEventDetail event={event} />
                <RunEventPayload detail={event.detail} eventId={event.id} />
              </div>
              <p className="text-left text-xs text-muted-foreground tabular-nums sm:text-right">
                {formatEventTime(event.createdAt)}
              </p>
            </article>
          ))
        ) : (
          <p className="rounded-md bg-secondary/60 px-3 py-6 text-center text-sm text-muted-foreground">
            {events.length
              ? "No log entries match this filter."
              : "Waiting for smoke or fuzz progress."}
          </p>
        )}
      </div>
    </section>
  );
}

const runLogFilters: Array<{ label: string; value: RunLogActionFilter }> = [
  { label: "All", value: "all" },
  { label: "Passed", value: "pass" },
  { label: "Tagged", value: "tag" },
  { label: "Held", value: "hold" },
  { label: "Dropped", value: "drop" },
  { label: "Shadow", value: "shadow_drop" },
  { label: "Rejected", value: "preflight_reject" },
];

function RunLogFilterControl({
  value,
  onChange,
}: {
  value: RunLogActionFilter;
  onChange: (value: RunLogActionFilter) => void;
}) {
  return (
    <div
      aria-label="Filter run log by action"
      className="flex min-h-11 flex-wrap items-center gap-1 rounded-md bg-background/70 p-1 shadow-button"
      role="group"
    >
      {runLogFilters.map((filter) => (
        <button
          aria-pressed={value === filter.value}
          className={`min-h-9 rounded-sm px-2.5 text-xs font-medium transition-colors duration-150 active:scale-[0.96] ${
            value === filter.value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
          key={filter.value}
          type="button"
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}

function RunEventIcon({
  source,
  status,
}: {
  source: RunEvent["source"];
  status: RunEvent["status"];
}) {
  const Icon =
    source === "propagation"
      ? RadioTower
      : source === "fuzz"
        ? FlaskConical
        : Activity;
  const tone =
    status === "failed"
      ? "text-destructive"
      : status === "passed"
        ? "text-accent"
        : "text-muted-foreground";

  return <Icon className={`size-4 ${tone}`} />;
}

function RunEventDetail({ event }: { event: RunEvent }) {
  const detail = readActionDetail(event.detail);

  if (!detail) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
      <span className={`rounded-sm px-2 py-1 font-medium ${actionBadgeClass(detail.action)}`}>
        Action: {detail.action}
      </span>
      <span className="rounded-sm bg-background/70 px-2 py-1">
        Tx: {shortHash(detail.txid)}
      </span>
      <span className="rounded-sm bg-background/70 px-2 py-1">
        Handling: {detail.handling}
      </span>
      {detail.fallback ? (
        <span className="rounded-sm bg-destructive/10 px-2 py-1 text-destructive">
          Fallback: {detail.fallback}
        </span>
      ) : null}
    </div>
  );
}

function RunEventPayload({
  detail,
  eventId,
}: {
  detail: unknown;
  eventId: number;
}) {
  const [isOpen, setIsOpen] = useState(false);

  if (detail === undefined) {
    return null;
  }

  return (
    <div className="mt-2">
      <button
        aria-controls={`run-event-detail-${eventId}`}
        aria-expanded={isOpen}
        className="inline-flex min-h-8 items-center gap-1 rounded-sm bg-background/70 px-2 text-xs font-medium text-muted-foreground shadow-button transition-colors hover:text-foreground"
        type="button"
        onClick={() => setIsOpen((value) => !value)}
      >
        {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Details
      </button>
      {isOpen ? (
        <pre
          className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/80 p-3 text-xs leading-5 text-muted-foreground"
          id={`run-event-detail-${eventId}`}
        >
          {JSON.stringify(detail, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function runEventActor(event: RunEvent) {
  if (event.source === "propagation") {
    return "Witnesses";
  }

  if (event.source === "fuzz") {
    return "Test Sender";
  }

  if (event.name.includes("Bouncer Runtime")) {
    return "Runtime";
  }

  if (event.name.includes("Forced")) {
    return "Live Agent";
  }

  return "Smoke";
}

function hasActiveRun(events: RunEvent[]) {
  const latestByRun = new Map<string, RunEvent>();

  for (const event of events) {
    latestByRun.set(event.runId, event);
  }

  return Array.from(latestByRun.values()).some((event) => event.status === "running");
}

function parseRunEvent(value: string): RunEvent | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const event = parsed as Record<string, unknown>;

    if (
      typeof event.id !== "number" ||
      typeof event.runId !== "string" ||
      typeof event.source !== "string" ||
      typeof event.name !== "string" ||
      typeof event.status !== "string" ||
      typeof event.createdAt !== "string"
    ) {
      return undefined;
    }

    if (
      event.source !== "smoke" &&
      event.source !== "fuzz" &&
      event.source !== "propagation"
    ) {
      return undefined;
    }

    if (
      event.status !== "running" &&
      event.status !== "passed" &&
      event.status !== "failed" &&
      event.status !== "skipped"
    ) {
      return undefined;
    }

    return {
      id: event.id,
      runId: event.runId,
      source: event.source,
      name: event.name,
      status: event.status,
      detail: event.detail,
      createdAt: event.createdAt,
    };
  } catch {
    return undefined;
  }
}

function mergeRunEvents(events: RunEvent[], event: RunEvent) {
  const next = events.filter((existing) => existing.id !== event.id);
  next.push(event);
  next.sort((left, right) => left.id - right.id);

  return next;
}

function readActionDetail(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const detail = value as Record<string, unknown>;

  if (
    typeof detail.action !== "string" ||
    typeof detail.txid !== "string" ||
    typeof detail.handling !== "string"
  ) {
    return undefined;
  }

  return {
    action: detail.action,
    txid: detail.txid,
    handling: detail.handling,
    fallback: typeof detail.fallback === "string" ? detail.fallback : undefined,
  };
}

function latestObservedPromptHealth(events: RunEvent[]) {
  for (const event of [...events].reverse()) {
    const health = readPromptHealth(event.detail);

    if (health) {
      return health;
    }
  }

  return undefined;
}

function readPromptHealth(value: unknown): HealthResponse | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const detail = value as Record<string, unknown>;

  if (typeof detail.status !== "string") {
    return undefined;
  }

  return {
    status: detail.status,
    prompt: typeof detail.prompt === "string" ? detail.prompt : undefined,
    promptHash:
      typeof detail.promptHash === "string" ? detail.promptHash : undefined,
    gateNode: typeof detail.gateNode === "string" ? detail.gateNode : undefined,
    propagationWitnesses: Array.isArray(detail.propagationWitnesses)
      ? detail.propagationWitnesses.filter(
          (witness): witness is string => typeof witness === "string",
        )
      : [],
  };
}

function runEventToneClass(event: RunEvent) {
  const action = readActionDetail(event.detail)?.action;

  if (event.status === "failed") {
    return "shadow-[inset_3px_0_0_var(--destructive)]";
  }

  if (action === "drop" || action === "preflight_reject") {
    return "shadow-[inset_3px_0_0_var(--destructive)]";
  }

  if (action === "shadow_drop") {
    return "shadow-[inset_3px_0_0_var(--accent)]";
  }

  if (action === "hold") {
    return "shadow-[inset_3px_0_0_var(--warning)]";
  }

  if (action === "pass" || action === "tag") {
    return "shadow-[inset_3px_0_0_var(--success)]";
  }

  return "";
}

function runEventPillTone(event: RunEvent): "neutral" | "good" | "warning" | "bad" | "shadow" {
  const action = readActionDetail(event.detail)?.action;

  if (event.status === "failed" || action === "drop" || action === "preflight_reject") {
    return "bad";
  }

  if (action === "shadow_drop") {
    return "shadow";
  }

  if (action === "hold") {
    return "warning";
  }

  if (action === "pass" || action === "tag" || event.status === "passed") {
    return "good";
  }

  return "neutral";
}

function actionBadgeClass(action: string) {
  if (action === "drop" || action === "preflight_reject") {
    return "bg-destructive/10 text-destructive";
  }

  if (action === "shadow_drop") {
    return "bg-accent/10 text-accent";
  }

  if (action === "hold") {
    return "bg-warning/10 text-warning";
  }

  if (action === "pass" || action === "tag") {
    return "bg-success/10 text-success";
  }

  return "bg-background/70 text-foreground";
}

function pillToneClass(tone: "neutral" | "good" | "warning" | "bad" | "shadow") {
  if (tone === "good") {
    return "bg-success/10 text-success";
  }

  if (tone === "warning") {
    return "bg-warning/10 text-warning";
  }

  if (tone === "bad") {
    return "bg-destructive/10 text-destructive";
  }

  if (tone === "shadow") {
    return "bg-accent/10 text-accent";
  }

  return "bg-muted text-muted-foreground";
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warning" | "bad" | "shadow";
}) {
  return (
    <span className={`inline-flex min-h-7 items-center rounded-sm px-2.5 text-xs font-medium shadow-button ${pillToneClass(tone)}`}>
      {children}
    </span>
  );
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}`);
  }

  return (await response.json()) as T;
}

function readPropagationDetail(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.txid !== "string" ||
    (record.expected !== "present" && record.expected !== "absent") ||
    typeof record.passed !== "boolean" ||
    !Array.isArray(record.nodes)
  ) {
    return undefined;
  }

  return {
    txid: record.txid,
    expected: record.expected,
    passed: record.passed,
    nodes: record.nodes.flatMap((node) => {
      if (!node || typeof node !== "object") {
        return [];
      }
      const nodeRecord = node as Record<string, unknown>;
      if (
        typeof nodeRecord.name !== "string" ||
        typeof nodeRecord.visible !== "boolean" ||
        typeof nodeRecord.passed !== "boolean"
      ) {
        return [];
      }

      return [
        {
          name: nodeRecord.name,
          visible: nodeRecord.visible,
          passed: nodeRecord.passed,
        },
      ];
    }),
  };
}

function extractTxidFromRunEvent(event?: RunEvent) {
  if (!Array.isArray(event?.detail)) {
    return undefined;
  }

  for (const item of event.detail) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const response = (item as Record<string, unknown>).response;
    if (!response || typeof response !== "object") {
      continue;
    }
    const txid = (response as Record<string, unknown>).txid;
    if (typeof txid === "string") {
      return txid;
    }
  }

  return undefined;
}

function shortHash(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function shortRunId(value: string) {
  const [prefix] = value.split("-");

  return prefix ? `Run: ${prefix}` : "Run";
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function summarizeResponse(value: unknown) {
  if (!value || typeof value !== "object") {
    return "No response body recorded";
  }

  const record = value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  const action = typeof record.action === "string" ? record.action : undefined;

  return [status, action, reason].filter(Boolean).join(" · ") || "Response body recorded";
}

function summarizeRunEventDetail(value: unknown) {
  if (Array.isArray(value)) {
    return `${value.length} candidate${value.length === 1 ? "" : "s"} submitted`;
  }

  if (!value || typeof value !== "object") {
    return value === undefined ? "No detail" : String(value);
  }

  const propagation = readPropagationDetail(value);
  if (propagation) {
    return `${shortHash(propagation.txid)} · ${propagation.expected} · ${propagation.passed ? "passed" : "failed"}`;
  }

  const record = value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  const shape = typeof record.shape === "string" ? record.shape : undefined;
  const action = typeof record.action === "string" ? record.action : undefined;
  const gateNode = typeof record.gateNode === "string" ? `Gate Node ${record.gateNode}` : undefined;
  const txid = typeof record.txid === "string" ? shortHash(record.txid) : undefined;

  return [shape, action, txid, status, reason, gateNode].filter(Boolean).join(" · ") || "Detail recorded";
}

function formatEventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString();
}

export default App;
