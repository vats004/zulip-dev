import $ from "jquery";
import assert from "minimalistic-assert";

import render_search_list_item from "../templates/search_list_item.hbs";

import {Typeahead} from "./bootstrap_typeahead";
import type {TypeaheadInputElement} from "./bootstrap_typeahead";
import {Filter} from "./filter";
import * as keydown_util from "./keydown_util";
import * as narrow_state from "./narrow_state";
import * as popovers from "./popovers";
import * as search_pill from "./search_pill";
import type {SearchPillWidget} from "./search_pill";
import * as search_suggestion from "./search_suggestion";
import type {NarrowTerm} from "./state_data";

// Exported for unit testing
export let is_using_input_method = false;
export let search_pill_widget: SearchPillWidget | null = null;
let search_input_has_changed = false;

let search_typeahead: Typeahead<string>;
let on_narrow_search: OnNarrowSearch;

function set_search_bar_text(text: string): void {
    $("#search_query").text(text);
    // After setting the text, move the cursor to the end of the line.
    window.getSelection()!.modify("move", "forward", "line");
}

function get_search_bar_text(): string {
    return $("#search_query").text();
}

// TODO/typescript: Add the rest of the options when converting narrow.js to typescript.
type NarrowSearchOptions = {
    trigger: string;
};

type OnNarrowSearch = (terms: NarrowTerm[], options: NarrowSearchOptions) => void;

function full_search_query_in_text(): string {
    assert(search_pill_widget !== null);
    return [
        search_pill.get_current_search_string_for_widget(search_pill_widget),
        get_search_bar_text(),
    ]
        .join(" ")
        .trim();
}

function narrow_or_search_for_term({on_narrow_search}: {on_narrow_search: OnNarrowSearch}): string {
    if (is_using_input_method) {
        // Neither narrow nor search when using input tools as
        // `updater` is also triggered when 'enter' is triggered
        // while using input tool
        return get_search_bar_text();
    }

    const search_query = full_search_query_in_text();
    if (search_query === "") {
        exit_search({keep_search_narrow_open: true});
        return "";
    }
    const terms = Filter.parse(search_query);
    // Reset the search bar to display as many pills as possible for `terms`.
    // We do this in case some of these terms haven't been pillified yet
    // because convert_to_pill_on_enter is false.
    assert(search_pill_widget !== null);
    search_pill_widget.clear(true);
    search_pill.set_search_bar_contents(terms, search_pill_widget, set_search_bar_text);
    on_narrow_search(terms, {trigger: "search"});

    // It's sort of annoying that this is not in a position to
    // blur the search box, because it means that Esc won't
    // unnarrow, it'll leave the searchbox.

    // Narrowing will have already put some terms in the search box,
    // so leave the current text in.
    $("#search_query").trigger("blur");
    return get_search_bar_text();
}

function focus_search_input_at_end(): void {
    $("#search_query").trigger("focus");
    // Move cursor to the end of the input text.
    window.getSelection()!.modify("move", "forward", "line");
}

function narrow_to_search_contents_with_search_bar_open(): void {
    // We skip validation when we're dealing with partial pills
    // since we don't want to do the shake animation for e.g. "dm:"
    // when the last bit of the pill hasn't been typed/selected yet.
    const text_terms = Filter.parse(get_search_bar_text());
    if (text_terms.at(-1)?.operand === "") {
        return;
    }
    if (!validate_text_terms()) {
        return;
    }
    const search_query = full_search_query_in_text();
    const terms = Filter.parse(search_query);
    on_narrow_search(terms, {trigger: "search"});

    // We want to keep the search bar open here, not show the
    // message header. But here we'll let the message header
    // get rendered first, so that it's up to date with the
    // new narrow, and then reopen search if it got closed.
    if ($(".navbar-search.expanded").length === 0) {
        open_search_bar_and_close_narrow_description();
        focus_search_input_at_end();
        search_typeahead.lookup(false);
        search_input_has_changed = true;
    }
}

function validate_text_terms(): boolean {
    const text_terms = Filter.parse(get_search_bar_text());
    // The shake animation will show if there is any invalid term in the,
    // search bar, even if it's not what the user just typed or selected.
    if (!text_terms.every((term) => Filter.is_valid_search_term(term))) {
        $("#search_query").addClass("shake");
        return false;
    }
    return true;
}

export function initialize(opts: {on_narrow_search: OnNarrowSearch}): void {
    on_narrow_search = opts.on_narrow_search;
    const $search_query_box = $<HTMLInputElement>("#search_query");
    const $searchbox_form = $("#searchbox_form");
    const $pill_container = $("#searchbox-input-container.pill-container");

    $("#searchbox_form").on("focusin", () => {
        $("#searchbox-input-container").toggleClass("focused", true);
    });

    $("#searchbox_form").on("focusout", () => {
        $("#searchbox-input-container").toggleClass("focused", false);
    });

    search_pill_widget = search_pill.create_pills($pill_container);
    search_pill_widget.onPillRemove(() => {
        search_input_has_changed = true;
    });

    $search_query_box.on("change", () => {
        search_typeahead.lookup(false);
    });

    // Data storage for the typeahead.
    // This maps a search string to an object with a "description_html" field.
    // (It's a bit of legacy that we have an object with only one important
    // field.  There's also a "search_string" field on each element that actually
    // just represents the key of the hash, so it's redundant.)
    let search_map = new Map<string, search_suggestion.Suggestion>();

    const bootstrap_typeahead_input: TypeaheadInputElement = {
        $element: $search_query_box,
        type: "contenteditable",
    };
    search_typeahead = new Typeahead(bootstrap_typeahead_input, {
        source(query: string): string[] {
            if (query !== "") {
                search_input_has_changed = true;
            }
            assert(search_pill_widget !== null);
            const query_from_pills =
                search_pill.get_current_search_string_for_widget(search_pill_widget);
            const add_current_filter =
                query_from_pills === "" && narrow_state.filter() !== undefined;
            const suggestions = search_suggestion.get_suggestions(
                query_from_pills,
                query,
                add_current_filter,
            );
            // Update our global search_map hash
            search_map = suggestions.lookup_table;
            return suggestions.strings;
        },
        non_tippy_parent_element: "#searchbox_form",
        items: search_suggestion.max_num_of_search_results,
        helpOnEmptyStrings: true,
        stopAdvance: true,
        requireHighlight: false,
        highlighter_html(item: string): string {
            const obj = search_map.get(item);
            return render_search_list_item(obj);
        },
        // When the user starts typing new search operands,
        // we want to highlight the first typeahead row by default
        // so that pressing Enter creates the default pill.
        // But when user isn't in the middle of typing a new pill,
        // pressing Enter should let them search for what's currently
        // in the search bar, so we remove the highlight (so that
        // Enter won't have anything to select).
        shouldHighlightFirstResult(): boolean {
            return get_search_bar_text() !== "";
        },
        hideAfterSelect(): boolean {
            const search_bar_text = get_search_bar_text();
            const text_terms = Filter.parse(search_bar_text);
            return text_terms.at(-1)?.operator === "search";
        },
        matcher(): boolean {
            return true;
        },
        updater(search_string: string): string {
            if (search_string) {
                search_input_has_changed = true;
                // Reset the search box and add the pills based on the selected
                // search suggestion.
                assert(search_pill_widget !== null);
                const search_terms = Filter.parse(search_string);
                search_pill.set_search_bar_contents(
                    search_terms,
                    search_pill_widget,
                    set_search_bar_text,
                );
                narrow_to_search_contents_with_search_bar_open();
                focus_search_input_at_end();
            }
            return get_search_bar_text();
        },
        // We do this ourselves in `search_pill.set_search_bar_contents`
        updateElementContent: false,
        sorter(items: string[]): string[] {
            return items;
        },
        // Turns off `stopPropagation` in the typeahead code for
        // backspace, arrow left, arrow right, and enter so that
        // we can manage those events for search pills.
        advanceKeyCodes: [8, 13, 37, 39],

        // Use our custom typeahead `on_escape` hook to exit
        // the search bar as soon as the user hits Esc.
        on_escape() {
            exit_search({keep_search_narrow_open: false});
        },
        tabIsEnter: false,
        openInputFieldOnKeyUp(): void {
            if ($(".navbar-search.expanded").length === 0) {
                open_search_bar_and_close_narrow_description();
            }
        },
        // This is here so that we can close the search bar
        // when a user opens it and immediately changes their
        // mind and clicks away.
        closeInputFieldOnHide(): void {
            if (!search_input_has_changed) {
                const filter = narrow_state.filter();
                if (!filter || filter.is_common_narrow()) {
                    close_search_bar_and_open_narrow_description();
                }
            }
        },
    });

    $searchbox_form.on("compositionend", (): void => {
        // Set `is_using_input_method` to true if Enter is pressed to exit
        // the input tool popover and get the text in the search bar. Then
        // we suppress searching triggered by this Enter key by checking
        // `is_using_input_method` before searching.
        // More details in the commit message that added this line.
        is_using_input_method = true;
    });

    let typeahead_was_open_on_enter = false;
    $searchbox_form
        .on("keydown", (e: JQuery.KeyDownEvent): void => {
            if (keydown_util.is_enter_event(e) && $search_query_box.is(":focus")) {
                // Don't submit the form so that the typeahead can instead
                // handle our Enter keypress. Any searching that needs
                // to be done will be handled in the keyup.
                e.preventDefault();
            }

            // Record this on keydown before the typeahead code closes the
            // typeahead, so we can use this information on keyup.
            if (keydown_util.is_enter_event(e) && $("#searchbox_form .typeahead").is(":visible")) {
                typeahead_was_open_on_enter = true;
            } else {
                typeahead_was_open_on_enter = false;
            }
        })
        .on("keyup", (e: JQuery.KeyUpEvent): void => {
            if (is_using_input_method) {
                is_using_input_method = false;
                return;
            }

            if (e.key === "Escape" && $search_query_box.is(":focus")) {
                exit_search({keep_search_narrow_open: false});
            } else if (
                keydown_util.is_enter_event(e) &&
                $search_query_box.is(":focus") &&
                !typeahead_was_open_on_enter
            ) {
                // If the typeahead was just open, the Enter event was selecting an item
                // from the typeahead. When that's the case, we don't want to call
                // narrow_or_search_for_term which exits the search bar, since the user
                // might have more terms to add still.
                if (!validate_text_terms()) {
                    return;
                }
                narrow_or_search_for_term({on_narrow_search});
            }
        });

    $("#searchbox-input-container").on("click", (): void => {
        // We don't want to put this in a focus handler because selecting the
        // typehead seems to trigger this (and we don't want to open search
        // when an option is selected and we're closing search).
        // Instead we explicitly initiate search on click and on specific keyboard
        // shortcuts.
        if ($("#searchbox .navbar-search.expanded").length === 0) {
            initiate_search();
        }
    });

    $(".search_icon").on("mousedown", (e: JQuery.MouseDownEvent): void => {
        e.preventDefault();
        // Clicking on the collapsed search box's icon opens search, but
        // clicking on the expanded search box's search icon does nothing.
        if ($(e.target).parents(".navbar-search.expanded").length === 0) {
            initiate_search();
        }
    });

    // Firefox leaves a <br> child element when the user enters search
    // input and then removes it, which breaks the :empty placeholder
    // text, so we need to manually remove it.
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1513303
    $("#search_query").on("input", () => {
        if (get_search_bar_text() === "") {
            $("#search_query").empty();
        }
        search_input_has_changed = true;
    });

    // register searchbar click handler
    $("#search_exit").on("click", (e: JQuery.ClickEvent): void => {
        exit_search({keep_search_narrow_open: false});
        e.preventDefault();
        e.stopPropagation();
    });
    $("#search_exit").on("blur", (e: JQuery.BlurEvent): void => {
        // Blurs that move focus to elsewhere within the search input shouldn't
        // close search.
        const related_target = e.relatedTarget;
        if (related_target && $(related_target).parents("#searchbox-input-container").length > 0) {
            return;
        }
        // But otherwise, it should behave like the input blurring.
        $("#search_query").trigger("blur");
    });
    // This prevents a bug where tab shows a visual change before the blur handler kicks in
    $("#search_exit").on("keydown", (e: JQuery.KeyDownEvent): void => {
        if (e.key === "tab") {
            popovers.hide_all();
            exit_search({keep_search_narrow_open: false});
            e.preventDefault();
            e.stopPropagation();
        }
    });
}

export function initiate_search(): void {
    open_search_bar_and_close_narrow_description(true);
    focus_search_input_at_end();

    // Open the typeahead after opening the search bar, so that we don't
    // get a weird visual jump where the typeahead results are narrow
    // before the search bar expands and then wider it expands.
    search_typeahead.lookup(false);
}

// we rely entirely on this function to ensure
// the searchbar has the right text/pills.
function reset_searchbox(clear = false): void {
    assert(search_pill_widget !== null);
    search_pill_widget.clear(true);
    search_input_has_changed = false;
    if (!clear) {
        search_pill.set_search_bar_contents(
            narrow_state.search_terms(),
            search_pill_widget,
            set_search_bar_text,
        );
    }
}

function exit_search(opts: {keep_search_narrow_open: boolean}): void {
    const filter = narrow_state.filter();
    if (!filter || filter.is_common_narrow()) {
        // for common narrows, we change the UI (and don't redirect)
        close_search_bar_and_open_narrow_description();
    } else if (opts.keep_search_narrow_open) {
        // If the user is in a search narrow and we don't want to redirect,
        // we just keep the search bar open and don't do anything.
        return;
    } else {
        window.location.href = filter.generate_redirect_url();
    }
    $("#search_query").trigger("blur");
    $(".app").trigger("focus");
}

export function open_search_bar_and_close_narrow_description(clear = false): void {
    reset_searchbox(clear);
    $(".navbar-search").addClass("expanded");
    $("#message_view_header").addClass("hidden");
    popovers.hide_all();
}

export function close_search_bar_and_open_narrow_description(): void {
    // Hide the dropdown before closing the search bar. We do this
    // to avoid being in a situation where the typeahead gets narrow
    // in width as the search bar closes, which doesn't look great.
    $("#searchbox_form .dropdown-menu").hide();

    if (search_pill_widget !== null) {
        search_pill_widget.clear(true);
    }

    $(".navbar-search").removeClass("expanded");
    $("#message_view_header").removeClass("hidden");

    if ($("#search_query").is(":focus")) {
        $("#search_query").trigger("blur");
        $(".app").trigger("focus");
    }
}
