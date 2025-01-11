import * as activity_ui from "./activity_ui";
import * as message_lists from "./message_lists";
import * as muted_users from "./muted_users";
import type {RawMutedUser} from "./muted_users";
import * as overlays from "./overlays";
import * as pm_list from "./pm_list";
import * as popovers from "./popovers";
import * as recent_view_ui from "./recent_view_ui";
import * as settings_muted_users from "./settings_muted_users";

export function rerender_for_muted_user(): void {
    for (const msg_list of message_lists.all_rendered_message_lists()) {
        msg_list.update_muting_and_rerender();
    }

    if (overlays.settings_open() && settings_muted_users.loaded) {
        settings_muted_users.populate_list();
    }

    activity_ui.redraw();
    pm_list.update_private_messages();

    // If a user is (un)muted, we want to update their avatars on the Recent Conversations
    // participants column.
    recent_view_ui.complete_rerender();
    // In theory, we might need to do inbox_ui.update here. But
    // because muting a user marks every message the user has sent as
    // read, it will update the inbox UI, if necessary through that
    // mechanism.
}

export function handle_user_updates(raw_muted_users: RawMutedUser[]): void {
    popovers.hide_all();
    muted_users.set_muted_users(raw_muted_users);
    rerender_for_muted_user();
}
