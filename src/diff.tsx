import { Action, ActionPanel, Form, Icon, environment, open, showToast, Toast } from "@raycast/api";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeText, renderDiffHtml } from "./diff-html";

interface FormValues {
  original: string;
  changed: string;
}

const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000;

async function removeOldDiffFiles(dir: string) {
  const now = Date.now();
  for (const name of await readdir(dir)) {
    if (!name.startsWith("diff-") || !name.endsWith(".html")) continue;
    const path = join(dir, name);
    if (now - (await stat(path)).mtimeMs > MAX_FILE_AGE_MS) await unlink(path).catch(() => undefined);
  }
}

async function showDiff(values: FormValues) {
  const original = normalizeText(values.original);
  const changed = normalizeText(values.changed);

  if (!original && !changed) {
    await showToast({ style: Toast.Style.Failure, title: "Enter some text to compare" });
    return;
  }
  if (original === changed) {
    await showToast({ style: Toast.Style.Success, title: "Texts are identical" });
    return;
  }

  try {
    const dir = environment.supportPath;
    await mkdir(dir, { recursive: true });
    await removeOldDiffFiles(dir);
    const file = join(dir, `diff-${Date.now()}.html`);
    await writeFile(file, renderDiffHtml(original, changed), "utf8");
    await open(file);
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not open diff",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Show Diff" icon={Icon.Switch} onSubmit={showDiff} />
        </ActionPanel>
      }
    >
      <Form.TextArea id="original" title="Original" placeholder="Paste the original text" autoFocus />
      <Form.TextArea id="changed" title="Changed" placeholder="Paste the changed text" />
    </Form>
  );
}
