/**
 * The Reads view: articles from the people you follow, or from everybody
 * replicated to this node, optionally filtered by topic (`?tag=`).
 *
 * @module
 */
import { PenLine } from "lucide-preact";
import { useState } from "preact/hooks";
import { ArticleList } from "../components/ArticleList.tsx";
import { Button } from "../components/Button.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { fetchArticles, fetchTopTags } from "../lib/articles.ts";
import { useAsync, useDocumentTitle } from "../lib/hooks.ts";
import { ownerPubkey } from "../lib/node.ts";
import { Link, useRoute } from "../lib/router.tsx";
import { canSign, session } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";

/** Which articles the list shows. */
type Scope = "following" | "network";

const SCOPE_KEY = "scuttlesaurus.reads.scope";

function readScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "network"
      ? "network"
      : "following";
  } catch {
    return "following";
  }
}

function rememberScope(scope: Scope): void {
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch {
    // storage unavailable: the choice lasts for this page view
  }
}

/** The Reads view. */
export default function ReadsView() {
  const { query } = useRoute();
  const tag = query.get("tag")?.trim() || undefined;
  const [scope, setScope] = useState<Scope>(readScope);
  const viewer = session.value?.pubkey ?? ownerPubkey.value ?? undefined;
  const topics = useAsync(() => fetchTopTags(24), []);
  useDocumentTitle("Reads");

  const choose = (next: Scope) => {
    rememberScope(next);
    setScope(next);
  };

  const topicList = topics.data ?? [];
  const activeTopicMissing = tag !== undefined &&
    !topicList.some((t) => t.tag === tag);

  const empty = tag
    ? {
      title: `Nothing on “${tag}” yet`,
      text: "No article from here has that topic.",
      action: <Button to="/reads">All topics</Button>,
    }
    : scope === "following"
    ? {
      title: "Nobody you follow has written anything yet",
      text:
        "Articles by you and by the people you follow appear here. Network shows everything replicated to this node.",
      action: (
        <Button variant="secondary" onClick={() => choose("network")}>
          Show Network
        </Button>
      ),
    }
    : {
      title: "Nothing here yet",
      text: "No articles have reached this node yet.",
    };

  return (
    <div class="page reads">
      <PageHeader
        title="Reads"
        subtitle="Long-form writing from the people near you."
        actions={canSign.value
          ? (
            <Button variant="primary" to="/write" icon={<PenLine size={18} />}>
              Write
            </Button>
          )
          : (
            <Button variant="secondary" onClick={openLogin}>
              Sign in to write
            </Button>
          )}
      />
      <div class="reads__controls">
        <Tabs
          label="Which articles"
          value={scope}
          onChange={choose}
          tabs={[
            { value: "following", label: "Following" },
            { value: "network", label: "Network" },
          ]}
        />
        {(topicList.length > 0 || tag) && (
          <nav class="topic-chips" aria-label="Topics">
            <Link
              class="topic-chip-link"
              to="/reads"
              aria-current={tag === undefined ? "page" : undefined}
            >
              All topics
            </Link>
            {activeTopicMissing && (
              <Link
                class="topic-chip-link"
                to={`/reads?tag=${encodeURIComponent(tag)}`}
                aria-current="page"
              >
                #{tag}
              </Link>
            )}
            {topicList.map((topic) => (
              <Link
                key={topic.tag}
                class="topic-chip-link"
                to={`/reads?tag=${encodeURIComponent(topic.tag)}`}
                aria-current={tag === topic.tag ? "page" : undefined}
              >
                #{topic.tag}
              </Link>
            ))}
          </nav>
        )}
      </div>
      <ArticleList
        resetKey={`${scope}|${viewer ?? ""}|${tag ?? ""}`}
        loadPage={(until, limit) =>
          fetchArticles({ scope, viewer, tag, until, limit })}
        empty={empty}
      />
    </div>
  );
}
