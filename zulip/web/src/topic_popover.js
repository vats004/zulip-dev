import ClipboardJS from "clipboard";
import $ from "jquery";

import render_delete_topic_modal from "../templates/confirm_dialog/confirm_delete_topic.hbs";
import render_left_sidebar_topic_actions_popover from "../templates/popovers/left_sidebar/left_sidebar_topic_actions_popover.hbs";

import * as confirm_dialog from "./confirm_dialog";
import {$t_html} from "./i18n";
import * as message_edit from "./message_edit";
import * as popover_menus from "./popover_menus";
import * as popover_menus_data from "./popover_menus_data";
import * as starred_messages_ui from "./starred_messages_ui";
import {realm} from "./state_data";
import * as stream_popover from "./stream_popover";
import * as ui_util from "./ui_util";
import * as unread_ops from "./unread_ops";
import * as user_topics from "./user_topics";
import * as util from "./util";

export function initialize() {
    popover_menus.register_popover_menu(
        "#stream_filters .topic-sidebar-menu-icon, .inbox-row .inbox-topic-menu",
        {
            ...popover_menus.left_sidebar_tippy_options,
            onShow(instance) {
                popover_menus.popover_instances.topics_menu = instance;
                ui_util.show_left_sidebar_menu_icon(instance.reference);
                popover_menus.on_show_prep(instance);
                let stream_id;
                let topic_name;
                let url;

                if (instance.reference.classList.contains("inbox-topic-menu")) {
                    const $elt = $(instance.reference);
                    stream_id = Number.parseInt($elt.attr("data-stream-id"), 10);
                    topic_name = $elt.attr("data-topic-name");
                    url = new URL($elt.attr("data-topic-url"), realm.realm_url);
                } else {
                    const $elt = $(instance.reference)
                        .closest(".topic-sidebar-menu-icon")
                        .expectOne();
                    const $stream_li = $elt.closest(".narrow-filter").expectOne();
                    topic_name = $elt.closest("li").expectOne().attr("data-topic-name");
                    url = $elt.closest("li").find(".sidebar-topic-name").expectOne().prop("href");
                    stream_id = stream_popover.elem_to_stream_id($stream_li);
                }

                instance.context = popover_menus_data.get_topic_popover_content_context({
                    stream_id,
                    topic_name,
                    url,
                });
                instance.setContent(
                    ui_util.parse_html(render_left_sidebar_topic_actions_popover(instance.context)),
                );
            },
            onMount(instance) {
                const $popper = $(instance.popper);
                const {stream_id, topic_name} = instance.context;

                if (!stream_id) {
                    popover_menus.hide_current_popover_if_visible(instance);
                    return;
                }

                $popper.on("change", "input[name='sidebar-topic-visibility-select']", (e) => {
                    const start_time = Date.now();
                    const visibility_policy = Number.parseInt(
                        $(e.currentTarget).attr("data-visibility-policy"),
                        10,
                    );

                    const success_cb = () => {
                        setTimeout(
                            () => {
                                popover_menus.hide_current_popover_if_visible(instance);
                            },
                            util.get_remaining_time(start_time, 500),
                        );
                    };

                    const error_cb = () => {
                        const prev_visibility_policy = user_topics.get_topic_visibility_policy(
                            stream_id,
                            topic_name,
                        );
                        const $prev_visibility_policy_input = $(e.currentTarget)
                            .parent()
                            .find(`input[data-visibility-policy="${prev_visibility_policy}"]`);
                        setTimeout(
                            () => {
                                $prev_visibility_policy_input.prop("checked", true);
                            },
                            util.get_remaining_time(start_time, 500),
                        );
                    };

                    user_topics.set_user_topic_visibility_policy(
                        stream_id,
                        topic_name,
                        visibility_policy,
                        false,
                        false,
                        undefined,
                        success_cb,
                        error_cb,
                    );
                });

                $popper.one("click", ".sidebar-popover-unstar-all-in-topic", () => {
                    starred_messages_ui.confirm_unstar_all_messages_in_topic(
                        Number.parseInt(stream_id, 10),
                        topic_name,
                    );
                    popover_menus.hide_current_popover_if_visible(instance);
                });

                $popper.one("click", ".sidebar-popover-mark-topic-read", () => {
                    unread_ops.mark_topic_as_read(stream_id, topic_name);
                    popover_menus.hide_current_popover_if_visible(instance);
                });

                $popper.one("click", ".sidebar-popover-mark-topic-unread", () => {
                    unread_ops.mark_topic_as_unread(stream_id, topic_name);
                    popover_menus.hide_current_popover_if_visible(instance);
                });

                $popper.one("click", ".sidebar-popover-delete-topic-messages", () => {
                    const html_body = render_delete_topic_modal({topic_name});

                    confirm_dialog.launch({
                        html_heading: $t_html({defaultMessage: "Delete topic"}),
                        help_link: "/help/delete-a-topic",
                        html_body,
                        on_click() {
                            message_edit.delete_topic(stream_id, topic_name);
                        },
                    });

                    popover_menus.hide_current_popover_if_visible(instance);
                });

                $popper.one("click", ".sidebar-popover-toggle-resolved", () => {
                    message_edit.with_first_message_id(stream_id, topic_name, (message_id) => {
                        message_edit.toggle_resolve_topic(message_id, topic_name, true);
                    });

                    popover_menus.hide_current_popover_if_visible(instance);
                });

                $popper.one("click", ".sidebar-popover-move-topic-messages", () => {
                    stream_popover.build_move_topic_to_stream_popover(stream_id, topic_name, false);
                    popover_menus.hide_current_popover_if_visible(instance);
                });

                $popper.one("click", ".sidebar-popover-rename-topic-messages", () => {
                    stream_popover.build_move_topic_to_stream_popover(stream_id, topic_name, true);
                    popover_menus.hide_current_popover_if_visible(instance);
                });

                new ClipboardJS($popper.find(".sidebar-popover-copy-link-to-topic")[0]).on(
                    "success",
                    () => {
                        popover_menus.hide_current_popover_if_visible(instance);
                    },
                );
            },
            onHidden(instance) {
                instance.destroy();
                popover_menus.popover_instances.topics_menu = undefined;
                ui_util.hide_left_sidebar_menu_icon();
            },
        },
    );
}
