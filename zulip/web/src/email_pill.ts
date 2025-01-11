import type {InputPillConfig, InputPillContainer, InputPillItem} from "./input_pill";
import * as input_pill from "./input_pill";

type EmailPill = {
    email: string;
};

export type EmailPillWidget = InputPillContainer<EmailPill>;

const email_regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function create_item_from_email(
    email: string,
    current_items: InputPillItem<EmailPill>[],
): InputPillItem<EmailPill> | undefined {
    if (!email_regex.test(email)) {
        return undefined;
    }

    const existing_emails = current_items.map((item) => item.email);
    if (existing_emails.includes(email)) {
        return undefined;
    }

    return {
        type: "email",
        display_value: email,
        email,
    };
}

export function get_email_from_item(item: InputPillItem<EmailPill>): string {
    return item.email;
}

export function get_current_email(
    pill_container: input_pill.InputPillContainer<EmailPill>,
): string | null {
    const current_text = pill_container.getCurrentText();
    if (current_text !== null && email_regex.test(current_text)) {
        return current_text;
    }
    return null;
}

export function create_pills(
    $pill_container: JQuery,
    pill_config?: InputPillConfig | undefined,
): input_pill.InputPillContainer<EmailPill> {
    const pill_container = input_pill.create({
        $container: $pill_container,
        pill_config,
        create_item_from_text: create_item_from_email,
        get_text_from_item: get_email_from_item,
    });
    return pill_container;
}
