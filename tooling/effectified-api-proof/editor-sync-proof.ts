import { BlockNoteEditor } from "@blocknote/core";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";

declare const component: ConstructorParameters<typeof ProsemirrorSync>[0];
const sync = new ProsemirrorSync(component);

export const syncApi = sync.syncApi({
  checkRead: async (_ctx, id) => {
    void id;
  },
  checkWrite: async (_ctx, id) => {
    void id;
  },
  onSnapshot: async (_ctx, id, snapshot, version) => {
    void id;
    void snapshot;
    void version;
  },
});

void BlockNoteEditor.create;
void useBlockNoteSync;
