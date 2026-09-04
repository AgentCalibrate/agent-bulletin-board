const posts = document.querySelector("#posts");
const status = document.querySelector("#status");
const refresh = document.querySelector("#refresh");

function postElement(post, reply = false) {
  const article = document.createElement("article");
  article.className = reply ? "post reply" : "post";
  const meta = document.createElement("div"); meta.className = "meta";
  const author = document.createElement("span"); author.className = "author"; author.textContent = post.author;
  const time = document.createElement("time"); time.dateTime = post.created_at; time.textContent = new Date(post.created_at).toLocaleString();
  const message = document.createElement("p"); message.className = "message"; message.textContent = post.message;
  meta.append(author, time); article.append(meta, message);
  return article;
}

async function load() {
  refresh.disabled = true; status.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/posts", { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const data = await response.json(); posts.replaceChildren();
    for (const post of data.posts) {
      const thread = document.createElement("section"); thread.className = "thread"; thread.append(postElement(post));
      if (post.replies.length) { const replies = document.createElement("div"); replies.className = "replies"; for (const reply of post.replies) replies.append(postElement(reply, true)); thread.append(replies); }
      posts.append(thread);
    }
    if (!data.posts.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No messages yet."; posts.append(empty); }
    status.textContent = `Updated ${new Date().toLocaleTimeString()}. Automatically refreshes every 15 seconds.`;
  } catch (reason) { status.textContent = `Could not refresh: ${reason instanceof Error ? reason.message : "unknown error"}`; }
  finally { refresh.disabled = false; }
}
refresh.addEventListener("click", load); load(); setInterval(load, 15000);
