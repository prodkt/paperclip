import { expect, request as pwRequest, test, type APIRequestContext, type Page } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

type Pipeline = { id: string; name: string };
type Stage = { id: string; name: string; position: number };
type PipelineItem = { id: string; title: string; stageId: string | null };

async function expectOk(response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string) {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
}

async function createCompany(board: APIRequestContext) {
  const response = await board.post("/api/companies", {
    data: { name: `E2E Pipelines ${Date.now()}` },
  });
  await expectOk(response, "create company");
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createPipeline(board: APIRequestContext, companyId: string): Promise<Pipeline> {
  const response = await board.post(`/api/companies/${companyId}/pipelines`, {
    data: {
      name: "Content production",
      description: "Draft, review, and publish launch content.",
    },
  });
  await expectOk(response, "create pipeline");
  return response.json() as Promise<Pipeline>;
}

async function createStage(
  board: APIRequestContext,
  pipelineId: string,
  data: { name: string; kind: string; position: number },
): Promise<Stage> {
  const response = await board.post(`/api/pipelines/${pipelineId}/stages`, {
    data: { ...data, config: { variables: [] } },
  });
  await expectOk(response, `create ${data.name} stage`);
  return response.json() as Promise<Stage>;
}

async function setTransitions(
  board: APIRequestContext,
  pipelineId: string,
  transitions: Array<{ fromStageId: string; toStageId: string }>,
) {
  const response = await board.put(`/api/pipelines/${pipelineId}/transitions`, {
    data: {
      transitions: transitions.map((transition) => ({ ...transition, config: {} })),
    },
  });
  await expectOk(response, "set transitions");
}

async function listItems(board: APIRequestContext, pipelineId: string): Promise<PipelineItem[]> {
  const response = await board.get(`/api/pipelines/${pipelineId}/cases`);
  await expectOk(response, "list pipeline items");
  return response.json() as Promise<PipelineItem[]>;
}

async function createItem(
  board: APIRequestContext,
  pipelineId: string,
  data: { title: string; stageId: string; parentCaseId?: string; fields?: Record<string, unknown> },
): Promise<PipelineItem> {
  const response = await board.post(`/api/pipelines/${pipelineId}/cases/ingest`, {
    data: {
      title: data.title,
      stageId: data.stageId,
      parentCaseId: data.parentCaseId,
      fields: data.fields ?? {},
    },
  });
  await expectOk(response, `create item ${data.title}`);
  return response.json() as Promise<PipelineItem>;
}

async function suggestTransition(board: APIRequestContext, itemId: string, toStageId: string) {
  const response = await board.post(`/api/cases/${itemId}/suggest-transition`, {
    data: {
      toStageId,
      reason: "Draft is ready for the next review.",
    },
  });
  await expectOk(response, "seed transition suggestion");
}

async function moveItem(
  board: APIRequestContext,
  itemId: string,
  toStageId: string,
  reason?: string,
) {
  const response = await board.post(`/api/cases/${itemId}/transition`, {
    data: {
      toStageId,
      reason,
    },
  });
  await expectOk(response, "move item");
}

async function visibleText(page: Page) {
  return page.locator("body").innerText();
}

async function expectProsumerVocabulary(page: Page) {
  const text = await visibleText(page);
  expect(text).not.toMatch(/\bcase\b/i);
  expect(text).not.toMatch(/\breview_decided\b|\btransition_forced\b/);
  expect(text).not.toMatch(/\b(?:400|401|403|404|409|422|500)\b/);
}

async function dragItemToColumn(page: Page, itemName: string, columnName: string) {
  const item = page.getByRole("button", { name: itemName }).first();
  const column = page.getByLabel(`${columnName} column`);
  await expect(item).toBeVisible();
  await expect(column).toBeVisible();

  const itemBox = await item.boundingBox();
  const columnBox = await column.boundingBox();
  if (!itemBox || !columnBox) {
    throw new Error(`Unable to measure ${itemName} or ${columnName} for drag`);
  }

  const startX = itemBox.x + itemBox.width / 2;
  const startY = itemBox.y + itemBox.height / 2;
  const targetX = columnBox.x + columnBox.width / 2;
  const targetY = columnBox.y + Math.min(columnBox.height - 24, Math.max(88, columnBox.height / 2));

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 8, startY + 8, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 24 });
  await page.mouse.up();
}

test.describe("Pipelines tutorial UI flow", () => {
  test.setTimeout(180_000);

  test("walks setup, intake, board moves, item detail, review queue, and learnings", async ({ page }) => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const company = await createCompany(board);
    const pipeline = await createPipeline(board, company.id);
    const drafting = await createStage(board, pipeline.id, { name: "Drafting", kind: "working", position: 0 });
    const published = await createStage(board, pipeline.id, { name: "Published", kind: "done", position: 2 });
    await setTransitions(board, pipeline.id, [{ fromStageId: drafting.id, toStageId: published.id }]);
    await page.goto("/");
    await page.evaluate((companyId) => {
      window.localStorage.setItem("paperclip.selectedCompanyId", companyId);
    }, company.id);
    const companyPath = `/${company.issuePrefix}`;

    await page.goto(`${companyPath}/pipelines/${pipeline.id}/settings`);
    await expect(page.getByRole("heading", { name: "Content production settings" })).toBeVisible();
    await page.getByRole("button", { name: "Add variable" }).click();
    await page.getByLabel("Variable key").fill("content_type");
    await page.getByLabel("Variable label").fill("Content type");
    await page.getByLabel("Variable type").selectOption("select");
    await page.getByLabel("Variable options").fill("Blog post, Changelog entry, Launch tweet");
    await page.getByRole("button", { name: "Save stage" }).click();
    await expect(page.getByText("Stage saved")).toBeVisible();

    await page.getByRole("button", { name: "Insert stage after Drafting" }).click();
    await expect(page.getByRole("button", { name: /^New stage Position/ })).toBeVisible();

    await page.getByLabel("Name").fill("Assets");
    await page.getByLabel("Kind").selectOption("review");
    await page.getByRole("switch").nth(1).click();
    await expect(page.getByLabel("Approval picker")).toHaveValue("any_human");
    await page.getByPlaceholder("Describe the work that should happen in this stage.").fill(
      "Review draft quality and ask for assets before publishing.",
    );
    await page.getByRole("button", { name: "Save stage" }).click();
    await expect(page.getByText("Stage saved")).toBeVisible();
    await expectProsumerVocabulary(page);

    await page.goto(`${companyPath}/pipelines/${pipeline.id}`);
    await page.getByRole("button", { name: "Add items" }).click();
    await expect(page.getByRole("heading", { name: "Add items" })).toBeVisible();
    await page.getByLabel("Title").nth(0).fill("Launch blog post");
    await page.getByLabel("Content type").nth(0).selectOption("Blog post");
    await page.getByRole("button", { name: "Add another item" }).click();
    await page.getByLabel("Title").nth(1).fill("Changelog entry");
    await page.getByLabel("Content type").nth(1).selectOption("Changelog entry");
    await page.getByRole("button", { name: "Add another item" }).click();
    await page.getByLabel("Title").nth(2).fill("Launch tweet");
    await page.getByLabel("Content type").nth(2).selectOption("Launch tweet");
    await expect(page.getByRole("button", { name: "Submit 3 items" })).toBeEnabled();
    await page.getByRole("button", { name: "Submit 3 items" }).click();
    await expect(page.getByText("Launch blog post")).toBeVisible();
    await expect(page.getByText("Changelog entry")).toBeVisible();
    await expect(page.getByText("Launch tweet")).toBeVisible();
    await expectProsumerVocabulary(page);

    const stagesResponse = await board.get(`/api/pipelines/${pipeline.id}/stages`);
    await expectOk(stagesResponse, "list stages");
    const stages = await stagesResponse.json() as Stage[];
    const assets = stages.find((stage) => stage.name === "Assets");
    const refreshedPublished = stages.find((stage) => stage.name === "Published");
    expect(assets).toBeTruthy();
    expect(refreshedPublished).toBeTruthy();

    let items = await listItems(board, pipeline.id);
    const blog = items.find((item) => item.title === "Launch blog post");
    const changelog = items.find((item) => item.title === "Changelog entry");
    const tweet = items.find((item) => item.title === "Launch tweet");
    expect(blog).toBeTruthy();
    expect(changelog).toBeTruthy();
    expect(tweet).toBeTruthy();

    await dragItemToColumn(page, "Launch blog post", "Assets");
    await expect(page.getByRole("heading", { name: "Move Launch blog post?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move it" })).toBeEnabled();
    await moveItem(board, blog!.id, assets!.id);
    await page.goto(`${companyPath}/pipelines/${pipeline.id}`);
    await expect(page.getByLabel("Assets column").getByText("Launch blog post")).toBeVisible();

    await dragItemToColumn(page, "Changelog entry", "Assets");
    await expect(page.getByRole("button", { name: "Move it" })).toBeEnabled();
    await moveItem(board, changelog!.id, assets!.id);
    await page.goto(`${companyPath}/pipelines/${pipeline.id}`);
    await expect(page.getByLabel("Assets column").getByText("Changelog entry")).toBeVisible();

    await dragItemToColumn(page, "Launch tweet", "Published");
    await expect(page.getByRole("heading", { name: "This skips the normal flow" })).toBeVisible();
    await page.getByLabel("Reason").fill("Tweet can skip review because the blog post already covers the announcement.");
    await expect(page.getByRole("button", { name: "Override and move" })).toBeEnabled();
    await moveItem(
      board,
      tweet!.id,
      refreshedPublished!.id,
      "Tweet can skip review because the blog post already covers the announcement.",
    );
    await page.goto(`${companyPath}/pipelines/${pipeline.id}`);
    await expect(page.getByLabel("Published column").getByText("Launch tweet")).toBeVisible();
    await expectProsumerVocabulary(page);

    await suggestTransition(board, blog!.id, refreshedPublished!.id);
    const root = await createItem(board, pipeline.id, {
      title: "Pipeline primitives launch",
      stageId: drafting.id,
      fields: { content_type: "Blog post" },
    });
    await createItem(board, pipeline.id, {
      title: "Launch package draft",
      stageId: drafting.id,
      parentCaseId: root.id,
      fields: { content_type: "Blog post" },
    });
    await createItem(board, pipeline.id, {
      title: "Launch package changelog",
      stageId: drafting.id,
      parentCaseId: root.id,
      fields: { content_type: "Changelog entry" },
    });

    await page.goto(`${companyPath}/pipelines/${pipeline.id}/items/${blog!.id}`);
    await expect(page.getByRole("heading", { name: "Launch blog post" })).toBeVisible();
    await expect(page.getByText("Agent suggests moving this item")).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("You approved the suggestion for Launch blog post.")).toBeVisible();
    await expectProsumerVocabulary(page);

    await page.goto(`${companyPath}/pipelines/${pipeline.id}/items/${root.id}`);
    await expect(page.getByRole("heading", { name: "Pipeline primitives launch" })).toBeVisible();
    await expect(page.getByText("Built from 2 items")).toBeVisible();
    await expectProsumerVocabulary(page);

    await page.goto(`${companyPath}/review-queue`);
    await expect(page.locator("main").getByRole("heading", { name: "Review queue" })).toBeVisible();
    await expect(page.getByText("Needs your attention")).toBeVisible();
    await page.getByRole("button", { name: /Launch blog post Content production/ }).first().click();
    await page.getByRole("button", { name: "Approve" }).last().click();
    await expect(page.getByText("Launch blog post")).toHaveCount(0);
    await page.getByRole("button", { name: /Changelog entry Content production/ }).first().click();
    await page.getByLabel("Note").fill("Tighten the framing before publishing.");
    await page.getByRole("button", { name: "Request changes" }).last().click();
    await expectProsumerVocabulary(page);

    await page.goto(`${companyPath}/learnings`);
    await expect(page.locator("main").getByRole("heading", { name: "Learnings" })).toBeVisible();
    await expect(page.getByText("Tighten the framing before publishing.")).toBeVisible();
    await expect(page.getByText("Tweet can skip review because the blog post already covers the announcement.")).toBeVisible();
    await expectProsumerVocabulary(page);

    await board.dispose();
  });
});
