// tooling/rail_helpers.mjs — shared navigation helpers for the audits.
// The rail is data-driven: a glyph arms the group's current tool and a chevron
// opens the tool menu, so selecting a specific tool is a two-step gesture.
// Built from the rail table itself so it can never drift from js/tools.js.
const { ITEM_LIST } = await import('../js/tools.js');
export const GROUP_OF = Object.fromEntries(ITEM_LIST.map((i) => [i.id, i.group]));

/** Open a group's menu by clicking its chevron. */
export async function openMenu(page, groupId) {
  await page.click(`#rail .rail-chev[data-chevron="${groupId}"]`);
  await page.waitForTimeout(180);
}

/** Select a tool through the rail exactly as a user does. */
export async function pickTool(page, toolId) {
  const group = GROUP_OF[toolId];
  if (!group) throw new Error(`pickTool: unknown tool ${toolId}`);
  await openMenu(page, group);
  await page.click(`#tool-menu button[data-item="${toolId}"]`);
  await page.waitForTimeout(180);
}

/** Icons group: the glyph opens the emoji picker, an emoji arms the icon tool. */
export async function pickEmoji(page, index = 0) {
  await page.click('#rail .rail-btn[data-group-id="icons"]');
  await page.waitForTimeout(180);
  await page.locator('#emoji-picker button').nth(index).click();
  await page.waitForTimeout(180);
}

/** Click a rail glyph (arms the group's current tool / runs a direct action). */
export async function clickGlyph(page, groupId) {
  await page.click(`#rail .rail-btn[data-group-id="${groupId}"]`);
  await page.waitForTimeout(180);
}

