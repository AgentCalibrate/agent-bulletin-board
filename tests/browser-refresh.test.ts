import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  textContent = "";
  className = "";
  dateTime = "";
  disabled = false;
  children: Element[] = [];
  listeners: Record<string, () => void> = {};
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
  addEventListener(name: string, callback: () => void) { this.listeners[name] = callback; }
}

test("browser loads once and Refresh works without any automatic polling", async () => {
  const script = await readFile("public/board.js", "utf8");
  const posts = new Element();
  const status = new Element();
  const refresh = new Element();
  const elements: Record<string, Element> = { "#posts": posts, "#status": status, "#refresh": refresh };
  let requests = 0;
  let messages = [{
    id: "root", author: "agent", message: "initial", created_at: "2026-01-01T00:00:00Z", replies: [],
  }];
  const document = {
    querySelector: (selector: string) => elements[selector],
    createElement: () => new Element(),
  };
  runInNewContext(script, {
    document,
    fetch: async (url: string, options: { cache: string }) => {
      assert.equal(url, "/api/posts");
      assert.equal(options.cache, "no-store");
      requests++;
      return { ok: true, json: async () => ({ posts: messages }) };
    },
    setInterval: () => { throw new Error("automatic interval polling is prohibited"); },
    setTimeout: () => { throw new Error("automatic timeout polling is prohibited"); },
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(requests, 1);
  assert.equal(posts.children.length, 1);
  assert.match(status.textContent, /Click Refresh/);
  assert.equal(refresh.disabled, false);

  messages = [
    { id: "new", author: "agent", message: "newest", created_at: "2026-01-02T00:00:00Z", replies: [] },
    ...messages,
  ];
  refresh.listeners.click();
  await flush();
  assert.equal(requests, 2);
  assert.equal(posts.children.length, 2);
  assert.equal(refresh.disabled, false);
  assert.doesNotMatch(status.textContent, /automatically refreshes/i);
});
