import type { IssueDeliverableItem, IssueDeliverablesResponse } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { projectWorkspaceUrl, relativeTime } from "@/lib/utils";
import { safeActionHref } from "@/lib/safeLinks";
import { EmptyState } from "./EmptyState";
import { PageSkeleton } from "./PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { FileText, FolderOpen, GitBranch, GitCommitHorizontal, Link2, MonitorUp, Package } from "lucide-react";

function labelize(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(/_/g, " ");
}

function formatByteSize(byteSize: number | null) {
  if (!byteSize || byteSize <= 0) return null;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function itemActionLabel(item: IssueDeliverableItem) {
  if (!item.url) return null;
  if (item.kind === "document" && item.url.startsWith("#document-")) return "Jump to document";
  if (item.kind === "preview_url" || item.kind === "runtime_service") return "Open preview";
  if (item.kind === "pull_request") return "Open PR";
  if (item.kind === "branch") return "View branch";
  if (item.kind === "commit") return "View commit";
  if (item.kind === "artifact" || item.kind === "attachment") return "Download";
  return "Open";
}

function itemIcon(item: IssueDeliverableItem) {
  switch (item.kind) {
    case "preview_url":
    case "runtime_service":
      return <MonitorUp className="h-4 w-4 text-muted-foreground" />;
    case "pull_request":
    case "branch":
      return <GitBranch className="h-4 w-4 text-muted-foreground" />;
    case "commit":
      return <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />;
    case "document":
      return <FileText className="h-4 w-4 text-muted-foreground" />;
    default:
      return <Package className="h-4 w-4 text-muted-foreground" />;
  }
}

function DeliverableAction({ href, label }: { href: string | null; label: string | null }) {
  const safeHref = safeActionHref(href, { allowHash: true });
  if (!safeHref || !label) return null;
  if (safeHref.startsWith("#")) {
    return (
      <Button asChild size="sm" variant="outline">
        <a href={safeHref}>{label}</a>
      </Button>
    );
  }
  return (
    <Button asChild size="sm" variant="outline">
      <a href={safeHref} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    </Button>
  );
}

function ItemCard({ item }: { item: IssueDeliverableItem }) {
  const actionLabel = itemActionLabel(item);
  const sizeLabel = formatByteSize(item.byteSize);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            {itemIcon(item)}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">
                updated {relativeTime(item.updatedAt)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{labelize(item.kind) ?? item.kind}</Badge>
            {item.provider ? <Badge variant="secondary">{item.provider}</Badge> : null}
            {item.status ? <Badge variant="secondary">{labelize(item.status)}</Badge> : null}
            {item.reviewState && item.reviewState !== "none" ? (
              <Badge variant="secondary">{labelize(item.reviewState)}</Badge>
            ) : null}
            {item.healthStatus && item.healthStatus !== "unknown" ? (
              <Badge variant="secondary">{labelize(item.healthStatus)}</Badge>
            ) : null}
            {item.documentKey ? <Badge variant="secondary">{item.documentKey}</Badge> : null}
            {item.contentType ? <Badge variant="secondary">{item.contentType}</Badge> : null}
            {item.isOperatorContext ? <Badge variant="secondary">Operator context</Badge> : null}
            {sizeLabel ? <Badge variant="secondary">{sizeLabel}</Badge> : null}
          </div>
          {item.summary ? <p className="text-sm text-muted-foreground">{item.summary}</p> : null}
        </div>
        <DeliverableAction href={item.url} label={actionLabel} />
      </div>
    </div>
  );
}

function DeliverableSection({
  id,
  title,
  items,
}: {
  id: string;
  title: string;
  items: IssueDeliverableItem[];
}) {
  if (items.length === 0) return null;

  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{items.length} item{items.length === 1 ? "" : "s"}</p>
      </div>
      <div className="grid gap-3">
        {items.map((item) => <ItemCard key={`${item.sourceType}:${item.id}`} item={item} />)}
      </div>
    </section>
  );
}

function workspaceDetailLink(input: {
  deliverables: IssueDeliverablesResponse;
  projectId: string | null;
  projectWorkspaceId: string | null;
}) {
  const workspace = input.deliverables.workspace;
  if (!workspace) return null;
  const linkedProjectWorkspaceId = workspace.projectWorkspaceId ?? input.projectWorkspaceId ?? null;
  if (workspace.mode === "shared_workspace" && input.projectId && linkedProjectWorkspaceId) {
    return projectWorkspaceUrl({ id: input.projectId }, linkedProjectWorkspaceId);
  }
  return `/execution-workspaces/${workspace.id}`;
}

export function IssueWorkProductTab({
  deliverables,
  projectId,
  projectWorkspaceId,
  isLoading = false,
  showOperatorContext = false,
  onShowOperatorContextChange,
}: {
  deliverables: IssueDeliverablesResponse | null | undefined;
  projectId: string | null;
  projectWorkspaceId: string | null;
  isLoading?: boolean;
  showOperatorContext?: boolean;
  onShowOperatorContextChange?: (checked: boolean) => void;
}) {
  if (isLoading && !deliverables) {
    return <PageSkeleton variant="list" />;
  }

  if (!deliverables) {
    return <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">Work product is unavailable right now.</div>;
  }

  const workspaceLink = workspaceDetailLink({ deliverables, projectId, projectWorkspaceId });

  return (
    <div className="space-y-4">
      {deliverables.primaryItem ? (
        <section id="issue-work-product-primary" className="scroll-mt-24 space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold">Primary output</h3>
              <p className="text-xs text-muted-foreground">The current best Work Product for this issue.</p>
            </div>
          </div>
          <ItemCard item={deliverables.primaryItem} />
        </section>
      ) : null}

      {deliverables.workspace ? (
        <section id="issue-work-product-workspace" className="scroll-mt-24 space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold">Current workspace</h3>
              <p className="text-xs text-muted-foreground">Where the latest execution context lives.</p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{deliverables.workspace.name}</span>
              <Badge variant="outline">{labelize(deliverables.workspace.mode)}</Badge>
              <Badge variant="secondary">{deliverables.workspace.providerType}</Badge>
              <Badge variant="secondary">{labelize(deliverables.workspace.status)}</Badge>
              {deliverables.workspace.runtimeServiceCount > 0 ? (
                <Badge variant="secondary">
                  runtime services: {deliverables.workspace.runtimeServiceCount}
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {deliverables.workspace.branchName ? <span>branch {deliverables.workspace.branchName}</span> : null}
              {deliverables.workspace.baseRef ? <span>base {deliverables.workspace.baseRef}</span> : null}
              <span>last used {relativeTime(deliverables.workspace.lastUsedAt)}</span>
            </div>
            {deliverables.workspace.runtimeServices.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {deliverables.workspace.runtimeServices.map((service) => (
                  <Badge key={service.id} variant="secondary">
                    {service.serviceName}: {labelize(service.status)}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
          {workspaceLink ? (
            <Button asChild size="sm" variant="outline">
              <Link to={workspaceLink}>Open workspace details</Link>
            </Button>
          ) : null}
        </section>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-muted-foreground">Show operator context</span>
        <ToggleSwitch
          checked={showOperatorContext}
          onCheckedChange={(checked) => onShowOperatorContextChange?.(checked)}
          aria-label="Show operator context"
        />
      </div>

      <DeliverableSection id="issue-work-product-previews" title="Previews" items={deliverables.previews} />
      <DeliverableSection id="issue-work-product-pull-requests" title="Pull requests" items={deliverables.pullRequests} />
      <DeliverableSection id="issue-work-product-branches" title="Branches" items={deliverables.branches} />
      <DeliverableSection id="issue-work-product-commits" title="Commits" items={deliverables.commits} />
      <DeliverableSection id="issue-work-product-files" title="Files" items={deliverables.files} />

      {!deliverables.summary.hasAny ? (
        <EmptyState
          icon={Package}
          message="No work product is registered for this issue yet. Previews, PRs, files, and other output will appear here when they are created."
        />
      ) : null}

      {deliverables.summary.hasAny && !deliverables.primaryItem ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Outputs exist for this issue, but no primary Work Product has been promoted yet.
        </div>
      ) : null}
    </div>
  );
}
