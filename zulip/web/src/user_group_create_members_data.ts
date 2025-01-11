import * as people from "./people";
import type {User} from "./people";
import {current_user} from "./state_data";

let user_id_set: Set<number>;

export function initialize_with_current_user(): void {
    user_id_set = new Set([current_user.user_id]);
}

export function sorted_user_ids(): number[] {
    const users = people.get_users_from_ids([...user_id_set]);
    people.sort_but_pin_current_user_on_top(users);
    return users.map((user) => user.user_id);
}

export function get_all_user_ids(): number[] {
    const potential_members = people.get_realm_users();
    const user_ids = potential_members.map((user) => user.user_id);
    // sort for determinism
    user_ids.sort((a, b) => a - b);
    return user_ids;
}

export function get_principals(): number[] {
    // Return list of user ids which were selected by user.
    return [...user_id_set];
}

export function get_potential_members(): User[] {
    const potential_members = people.get_realm_users();
    return potential_members.filter((user) => !user_id_set.has(user.user_id));
}

export function add_user_ids(user_ids: number[]): void {
    for (const user_id of user_ids) {
        if (!user_id_set.has(user_id)) {
            const user = people.maybe_get_user_by_id(user_id);
            if (user) {
                user_id_set.add(user_id);
            }
        }
    }
}

export function remove_user_ids(user_ids: number[]): void {
    for (const user_id of user_ids) {
        user_id_set.delete(user_id);
    }
}
