import autosize from "autosize";
import $ from "jquery";
import assert from "minimalistic-assert";

import * as blueslip from "./blueslip";
import * as compose_tooltips from "./compose_tooltips";
import {MessageListData} from "./message_list_data";
import * as message_list_tooltips from "./message_list_tooltips";
import {MessageListView} from "./message_list_view";
import * as narrow_banner from "./narrow_banner";
import * as narrow_state from "./narrow_state";
import {page_params} from "./page_params";
import {web_mark_read_on_scroll_policy_values} from "./settings_config";
import * as stream_data from "./stream_data";
import * as unread from "./unread";
import {user_settings} from "./user_settings";

export class MessageList {
    static id_counter = 0;
    // A MessageList is the main interface for a message feed that is
    // rendered in the DOM. Code outside the message feed rendering
    // internals will directly call this module in order to manipulate
    // a message feed.
    //
    // Each MessageList has an associated MessageListData, which
    // manages the messages, and a MessageListView, which manages the
    // the templates/HTML rendering as well as invisible pagination.
    //
    // TODO: The abstraction boundary between this and MessageListView
    // is not particularly well-defined; it could be nice to figure
    // out a good rule.
    constructor(opts) {
        MessageList.id_counter += 1;
        this.id = MessageList.id_counter;
        // The MessageListData keeps track of the actual sequence of
        // messages displayed by this MessageList. Most
        // configuration/logic questions in this module will be
        // answered by calling a function from the MessageListData,
        // its Filter, or its FetchStatus object.
        if (opts.data) {
            this.data = opts.data;
        } else {
            const filter = opts.filter;

            this.data = new MessageListData({
                excludes_muted_topics: opts.excludes_muted_topics,
                filter,
            });
        }

        // TODO: This property should likely just be inlined into
        // having the MessageListView code that needs to access it
        // query .data.filter directly.
        const collapse_messages = this.data.filter.supports_collapsing_recipients();

        // The MessageListView object that is responsible for
        // maintaining this message feed's HTML representation in the
        // DOM.
        this.view = new MessageListView(this, collapse_messages, opts.is_node_test);

        // If this message list is for the combined feed view.
        this.is_combined_feed_view = this.data.filter.is_in_home();

        // Keeps track of whether the user has done a UI interaction,
        // such as "Mark as unread", that should disable marking
        // messages as read until prevent_reading is called again.
        //
        // Distinct from filter.can_mark_messages_read(), which is a
        // property of the type of narrow, regardless of actions by
        // the user. Possibly this can be unified in some nice way.
        this.reading_prevented = false;

        return this;
    }

    should_preserve_current_rendered_state() {
        // Whether this message list is preserved in the DOM even
        // when viewing other views -- a valuable optimization for
        // fast toggling between the combined feed and other views,
        // which we enable only when that is the user's home view.
        //
        // This is intentionally not live-updated when web_home_view
        // changes, since it's easier to reason about if this
        // optimization is active or not for an entire session.
        if (user_settings.web_home_view !== "all_messages" || !this.is_combined_feed_view) {
            return false;
        }

        // If we click on a narrow, we go the first unread message.
        // If first unread message is not available in a cached message list,
        // we render by selecting the `message_list.last()` message.
        // This is incorrect unless we have found the newest message.
        //
        // So, we don't preserve the rendered state of this list if first unread message
        // is not available to us. Otherwise, this leads to confusion when we are
        // restoring the rendered list but our first unread message is not available
        // and fetching it from the server could lead to non-contiguous messages history.
        //
        // NOTE: Non-contiguous message history can still happen in the opposite situation
        // where user is narrowing to a message id which is not present in the rendered list.
        // In this case, we create a new list and if the new fetched history contains first
        // unread message, we preserve this list and discard others with the same filter.
        //
        // This nicely supports the common workflow of user reloading with a `then_select_id`
        // and then scrolling to the first unread message; then narrowing to the unread topic
        // and combing back to combined feed. The combined feed will be rendered in this case
        // but not if we decided to discard this list based on if anchor was on `first_unread.
        //
        // Since we know we are checking for first unread unmuted message in combined feed,
        // we can use `unread.first_unread_unmuted_message_id` to correctly check if we have
        // fetched the first unread message.
        //
        // TODO: For supporting other narrows, we need to check if we have fetched the first
        // unread message for that narrow, for which we will have to query server for the
        // first unread message id. Maybe that can be part of the narrow fetch query itself.
        const first_unread_message = this.get(unread.first_unread_unmuted_message_id);
        if (!first_unread_message?.unread) {
            // If we have found the newest message, we can preserve the rendered state.
            return this.data.fetch_status.has_found_newest();
        }

        // If we have found the first unread message, we can preserve the rendered state.
        return true;
    }

    is_current_message_list() {
        return this.view.is_current_message_list();
    }

    prevent_reading() {
        this.reading_prevented = true;
    }

    resume_reading() {
        this.reading_prevented = false;
    }

    add_messages(messages, opts) {
        // This adds all messages to our data, but only returns
        // the currently viewable ones.
        const info = this.data.add_messages(messages);

        const top_messages = info.top_messages;
        const bottom_messages = info.bottom_messages;
        const interior_messages = info.interior_messages;

        // Currently we only need data back from rendering to
        // tell us whether users needs to scroll, which only
        // applies for `append_to_view`, but this may change over
        // time.
        let render_info;

        if (interior_messages.length > 0) {
            this.view.rerender_preserving_scrolltop(true);
            return {need_user_to_scroll: true};
        }
        if (top_messages.length > 0) {
            this.view.prepend(top_messages);
        }

        if (bottom_messages.length > 0) {
            render_info = this.append_to_view(bottom_messages, opts);
        }

        if (!this.visibly_empty() && this.is_current_message_list()) {
            // If adding some new messages to the message tables caused
            // our current narrow to no longer be empty, hide the empty
            // feed placeholder text.
            narrow_banner.hide_empty_narrow_message();
        }

        if (!this.visibly_empty() && this.selected_id() === -1 && this.is_current_message_list()) {
            // The message list was previously empty, but now isn't
            // due to adding these messages, and we need to select a
            // message. Regardless of whether the messages are new or
            // old, we want to select a message as though we just
            // entered this view.
            const first_unread_message_id = this.first_unread_message_id();
            assert(first_unread_message_id !== undefined);
            this.select_id(first_unread_message_id, {then_scroll: true, use_closest: true});
        }

        return render_info;
    }

    get(id) {
        return this.data.get(id);
    }

    msg_id_in_fetched_range(msg_id) {
        return this.data.msg_id_in_fetched_range(msg_id);
    }

    num_items() {
        return this.data.num_items();
    }

    empty() {
        return this.data.empty();
    }

    visibly_empty() {
        return this.data.visibly_empty();
    }

    first() {
        return this.data.first();
    }

    last() {
        return this.data.last();
    }

    prev() {
        return this.data.prev();
    }

    next() {
        return this.data.next();
    }

    is_at_end() {
        return this.data.is_at_end();
    }

    is_keyword_search() {
        return this.data.is_keyword_search();
    }

    can_mark_messages_read() {
        /* Automatically marking messages as read can be disabled for
           three different reasons:
           * The view is structurally a search view, encoded in the
             properties of the message_list_data object.
           * The user recently marked messages in the view as unread, and
             we don't want to lose that state.
           * The user has "Automatically mark messages as read" option
             turned on in their user settings.
        */
        const filter = this.data.filter;
        const is_conversation_view = filter === undefined ? false : filter.is_conversation_view();
        return (
            this.data.can_mark_messages_read() &&
            !this.reading_prevented &&
            !(
                user_settings.web_mark_read_on_scroll_policy ===
                web_mark_read_on_scroll_policy_values.never.code
            ) &&
            !(
                user_settings.web_mark_read_on_scroll_policy ===
                    web_mark_read_on_scroll_policy_values.conversation_only.code &&
                !is_conversation_view
            )
        );
    }

    can_mark_messages_read_without_setting() {
        /*
            Similar to can_mark_messages_read() above, this is a helper
            function to check if messages can be automatically read without
            the "Automatically mark messages as read" setting.
        */
        return this.data.can_mark_messages_read() && !this.reading_prevented;
    }

    clear({clear_selected_id = true} = {}) {
        this.data.clear();
        this.view.clear_rendering_state(true);

        if (clear_selected_id) {
            this.data.clear_selected_id();
        }
    }

    selected_id() {
        return this.data.selected_id();
    }

    select_id(id, opts) {
        opts = {
            then_scroll: false,
            target_scroll_offset: undefined,
            use_closest: false,
            empty_ok: false,
            mark_read: true,
            force_rerender: false,
            ...opts,
            id,
            msg_list: this,
            previously_selected_id: this.data.selected_id(),
        };

        const convert_id = (str_id) => {
            const id = Number.parseFloat(str_id);
            if (Number.isNaN(id)) {
                throw new TypeError("Bad message id " + str_id);
            }
            return id;
        };

        id = convert_id(id);

        const closest_id = this.closest_id(id);

        let error_data;

        // The name "use_closest" option is a bit legacy.  We
        // are always gonna move to the closest visible id; the flag
        // just says whether we call blueslip.error or not.  The caller
        // sets use_closest to true when it expects us to move the
        // pointer as needed, so only generate an error if the flag is
        // false.
        if (!opts.use_closest && closest_id !== id) {
            error_data = {
                filter_terms: this.filter.terms(),
                id,
                closest_id,
            };
            blueslip.error("Selected message id not in MessageList", error_data);
        }

        if (closest_id === -1 && !opts.empty_ok) {
            error_data = {
                filter_terms: this.filter.terms(),
                id,
                items_length: this.data.num_items(),
            };
            blueslip.error("Cannot select id -1", error_data);
            throw new Error("Cannot select id -1");
        }

        id = closest_id;
        opts.id = id;
        this.data.set_selected_id(id);

        if (opts.force_rerender) {
            // TODO: Because rerender() itself will call
            // reselect_selected_id after doing the rendering, we
            // actually end up with this function being called
            // recursively in this case. The ordering will end up
            // being that the message_selected.zulip event for that
            // rerender is processed before execution returns here.
            //
            // The recursive call is unnecessary, so we should figure
            // out how to avoid that, both here and in the next block.
            this.rerender();
        } else if (!opts.from_rendering) {
            this.view.maybe_rerender();
        }

        $(document).trigger(new $.Event("message_selected.zulip", opts));
    }

    selected_message() {
        return this.get(this.data.selected_id());
    }

    selected_row() {
        return this.get_row(this.data.selected_id());
    }

    closest_id(id) {
        return this.data.closest_id(id);
    }

    advance_past_messages(msg_ids) {
        return this.data.advance_past_messages(msg_ids);
    }

    selected_idx() {
        return this.data.selected_idx();
    }

    // Maintains a trailing bookend element explaining any changes in
    // your subscribed/unsubscribed status at the bottom of the
    // message list.
    update_trailing_bookend(force_render = false) {
        this.view.clear_trailing_bookend();
        if (this.is_combined_feed_view) {
            return;
        }

        const stream_name = narrow_state.stream_name();
        if (stream_name === undefined) {
            // Trailing bookends are only for channel views.
            return;
        }

        // If user narrows to a stream, don't update
        // trailing bookend if user is subscribed.
        const sub = stream_data.get_sub(stream_name);
        if (
            sub &&
            sub.subscribed &&
            !this.last_message_historical &&
            !page_params.is_spectator &&
            !force_render
        ) {
            return;
        }

        let deactivated = false;
        let just_unsubscribed = false;
        const subscribed = stream_data.is_subscribed_by_name(stream_name);
        const invite_only = sub && sub.invite_only;
        const is_web_public = sub && sub.is_web_public;
        const can_toggle_subscription =
            sub !== undefined && stream_data.can_toggle_subscription(sub);
        if (sub === undefined) {
            deactivated = true;
        } else if (!subscribed && !this.last_message_historical) {
            just_unsubscribed = true;
        }

        this.view.render_trailing_bookend(
            stream_name,
            subscribed,
            deactivated,
            just_unsubscribed,
            can_toggle_subscription,
            page_params.is_spectator,
            invite_only,
            is_web_public,
        );
    }

    unmuted_messages(messages) {
        return this.data.unmuted_messages(messages);
    }

    append(messages, opts) {
        const viewable_messages = this.data.append(messages);
        this.append_to_view(viewable_messages, opts);
    }

    append_to_view(messages, {messages_are_new = false} = {}) {
        const render_info = this.view.append(messages, messages_are_new);
        return render_info;
    }

    remove_and_rerender(message_ids) {
        this.data.remove(message_ids);
        this.rerender();
    }

    show_edit_message($row, $form) {
        if ($row.find(".message_edit_form form").length !== 0) {
            return;
        }
        $row.find(".message_edit_form").append($form);
        $row.find(".message_content, .status-message, .message_controls").hide();
        $row.find(".messagebox-content").addClass("content_edit_mode");
        $row.find(".message_edit").css("display", "block");
        // autosize will not change the height of the textarea if the `$row` is not
        // rendered in DOM yet. So, we call `autosize.update` post render.
        autosize($row.find(".message_edit_content"));
    }

    hide_edit_message($row) {
        compose_tooltips.hide_compose_control_button_tooltips($row);
        $row.find(".message_content, .status-message, .message_controls").show();
        $row.find(".message_edit_form").empty();
        $row.find(".messagebox-content").removeClass("content_edit_mode");
        $row.find(".message_edit").hide();
        $row.trigger("mouseleave");
    }

    show_edit_topic_on_recipient_row($recipient_row, $form) {
        $recipient_row.find(".topic_edit_form").append($form);
        $recipient_row.find(".on_hover_topic_edit").hide();
        $recipient_row.find(".edit_message_button").hide();
        $recipient_row.find(".stream_topic").hide();
        $recipient_row.find(".topic_edit").show();
        $recipient_row.find(".always_visible_topic_edit").hide();
        $recipient_row.find(".on_hover_topic_resolve").hide();
        $recipient_row.find(".on_hover_topic_unresolve").hide();
    }

    hide_edit_topic_on_recipient_row($recipient_row) {
        $recipient_row.find(".stream_topic").show();
        $recipient_row.find(".on_hover_topic_edit").show();
        $recipient_row.find(".edit_message_button").show();
        $recipient_row.find(".topic_edit_form").empty();
        $recipient_row.find(".topic_edit").hide();
        $recipient_row.find(".always_visible_topic_edit").show();
        $recipient_row.find(".on_hover_topic_resolve").show();
        $recipient_row.find(".on_hover_topic_unresolve").show();
    }

    reselect_selected_id() {
        const selected_id = this.data.selected_id();

        if (selected_id !== -1) {
            this.select_id(this.data.selected_id(), {from_rendering: true, mark_read: false});
        }
    }

    rerender_view() {
        this.view.rerender_preserving_scrolltop();
        this.reselect_selected_id();
    }

    rerender() {
        // We need to destroy all the tippy instances from the DOM before re-rendering to
        // prevent the appearance of tooltips whose reference has been removed.
        message_list_tooltips.destroy_all_message_list_tooltips();
        // We need to clear the rendering state, rather than just
        // doing clear_table, since we want to potentially recollapse
        // things.
        this.data.reset_select_to_closest();
        this.view.clear_rendering_state(false);
        this.view.update_render_window(this.selected_idx(), false);

        if (!this.is_combined_feed_view) {
            if (
                this.visibly_empty() &&
                this.data.fetch_status.has_found_oldest() &&
                this.data.fetch_status.has_found_newest()
            ) {
                // Show the empty narrow message only if we're certain
                // that the view doesn't have messages that we're
                // waiting for the server to send us.
                narrow_banner.show_empty_narrow_message();
            } else {
                narrow_banner.hide_empty_narrow_message();
            }
        }
        this.rerender_view();
    }

    update_muting_and_rerender() {
        this.data.update_items_for_muting();
        // We need to rerender whether or not the narrow hides muted
        // topics, because we need to update recipient bars for topics
        // we've muted when we are displaying those topics.
        //
        // We could avoid a rerender if we can provide that this
        // narrow cannot have contained messages to muted topics
        // either before or after the state change.  The right place
        // to do this is in the message_events.js code path for
        // processing topic edits, since that's the only place we'll
        // call this frequently anyway.
        //
        // But in any case, we need to rerender the list for user muting,
        // to make sure only the right messages are hidden.
        this.rerender();
    }

    all_messages() {
        return this.data.all_messages();
    }

    first_unread_message_id() {
        return this.data.first_unread_message_id();
    }

    has_unread_messages() {
        return this.data.has_unread_messages();
    }

    message_range(start, end) {
        return this.data.message_range(start, end);
    }

    get_row(id) {
        return this.view.get_row(id);
    }

    change_message_id(old_id, new_id) {
        const require_rerender = this.data.change_message_id(old_id, new_id);
        if (require_rerender) {
            this.rerender_view();
        }
    }

    get_last_message_sent_by_me() {
        return this.data.get_last_message_sent_by_me();
    }
}
