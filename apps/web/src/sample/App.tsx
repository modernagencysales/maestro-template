import { useEffect, useState } from "react";
import {
  NotionDocumentPage,
  TemplateLiveRegion,
  TemplateNetworkBanner,
  TemplateSkipLink,
  TemplateToastProvider,
  TemplateWorkspaceShell,
  type NotionDocumentPageModel,
} from "@maestro-template/ui";
import {
  WorkflowCanvas,
  WorkflowGraphCanvas,
} from "@maestro-template/workflow-ui";
import { TEMPLATE_NAV_CATEGORIES } from "../navigation/workspace";
import { LiveWorkflowRunsPanel } from "../features/workflows/live-runs-panel";
import { navItems } from "./navItems";
import { overviewPage, pages, type DocumentPage } from "./sampleDocumentData";

type RenderedDocumentPage = Omit<DocumentPage, "diagram"> &
  Pick<NotionDocumentPageModel, "diagram" | "diagramLabel">;

const pageById = new Map(pages.map((page) => [page.id, page]));
const samplePageKeyByRouteKey = new Map<string, string>([
  ["home", "overview"],
  ["brain", "brain"],
  ["workflows", "workflows"],
  ["capabilities", "capabilities"],
  ["agents", "agents"],
  ["runs", "runs"],
  ["documents", "documents"],
  ["sources", "sources"],
  ["api", "headless"],
  ["onboarding", "onboarding"],
  ["dataMap", "data-map"],
  ["notifications", "notifications"],
  ["integrations", "integrations"],
  ["settings", "settings"],
  ["legal", "legal"],
  ["billing", "billing"],
  ["analytics", "analytics"],
  ["health", "safety"],
  ["admin", "admin"],
]);
const sampleRouteKeyByPageId = new Map(
  [...samplePageKeyByRouteKey.entries()].map(([key, value]) => [value, key]),
);
const sampleNavigation = TEMPLATE_NAV_CATEGORIES.map((category) => ({
  ...category,
  items: category.items.map((item) => ({
    key: item.key,
    label: item.key === "health" ? "Safety" : item.label,
    icon: item.icon,
    href: `#${samplePageKeyByRouteKey.get(item.key) ?? item.key}`,
    ...(item.key === "api" ? { hint: "Scalar" } : {}),
  })),
}));
const samplePageIdFromHash = () => {
  if (typeof window === "undefined") {
    return navItems[0]?.id ?? "overview";
  }

  const hash = window.location.hash.replace(/^#/, "");

  return pageById.has(hash) ? hash : (navItems[0]?.id ?? "overview");
};

const renderPage = (page: DocumentPage): RenderedDocumentPage => {
  const { diagram, ...documentPage } = page;

  if (!diagram) {
    return documentPage;
  }

  return {
    ...documentPage,
    diagramLabel: diagram.label,
    diagram: diagram.graph ? (
      <WorkflowGraphCanvas graph={diagram.graph} />
    ) : (
      <WorkflowCanvas nodes={diagram.nodes ?? []} edges={diagram.edges ?? []} />
    ),
  };
};

export function App() {
  const [activeNavId, setActiveNavId] = useState<string>(samplePageIdFromHash);
  const activePage = pageById.get(activeNavId) ?? overviewPage;
  const activeRouteKey = sampleRouteKeyByPageId.get(activePage.id) ?? "home";

  useEffect(() => {
    const handleHashChange = () => {
      setActiveNavId(samplePageIdFromHash());
    };

    window.addEventListener("hashchange", handleHashChange);

    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return (
    <>
      <TemplateSkipLink />
      <TemplateLiveRegion
        message={`Viewing ${activePage.id === "overview" ? "Overview" : activePage.title}`}
      />
      <TemplateNetworkBanner state="online" />
      <TemplateToastProvider>
        <TemplateWorkspaceShell
          title="Maestro Template"
          subtitle="Private AI app factory"
          navigation={sampleNavigation}
          activeKey={activeRouteKey}
          topbarTitle={activePage.title}
          onNavigate={(key) => {
            const pageId = samplePageKeyByRouteKey.get(key) ?? "overview";

            setActiveNavId(pageId);
          }}
        >
          <NotionDocumentPage page={renderPage(activePage)} />
          {/* Sibling of .notion-page on purpose: the visual baseline
              screenshots the document element, and live data must never
              shift a pinned screenshot. */}
          {activePage.id === "workflows" ? <LiveWorkflowRunsPanel /> : null}
        </TemplateWorkspaceShell>
      </TemplateToastProvider>
    </>
  );
}
