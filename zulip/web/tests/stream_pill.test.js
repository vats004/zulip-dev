"use strict";

const {strict: assert} = require("assert");

const {zrequire} = require("./lib/namespace");
const {run_test} = require("./lib/test");
const {current_user} = require("./lib/zpage_params");

const peer_data = zrequire("peer_data");
const people = zrequire("people");
const stream_data = zrequire("stream_data");
const stream_pill = zrequire("stream_pill");

const denmark = {
    stream_id: 101,
    name: "Denmark",
    subscribed: true,
};
const sweden = {
    stream_id: 102,
    name: "Sweden",
    subscribed: false,
};
const germany = {
    stream_id: 103,
    name: "Germany",
    subscribed: false,
    invite_only: true,
};

peer_data.set_subscribers(denmark.stream_id, [1, 2, 3, 77]);
peer_data.set_subscribers(sweden.stream_id, [1, 2, 3, 4, 5]);

const denmark_pill = {
    type: "stream",
    display_value: "Denmark: 3 users",
    stream: denmark,
};
const sweden_pill = {
    type: "stream",
    display_value: "translated: Sweden: 5 users",
    stream: sweden,
};

const subs = [denmark, sweden, germany];
for (const sub of subs) {
    stream_data.add_sub(sub);
}

const me = {
    email: "me@example.com",
    user_id: 5,
    full_name: "Me Myself",
};

people.add_active_user(me);
people.initialize_current_user(me.user_id);

run_test("create_item", () => {
    current_user.user_id = me.user_id;
    current_user.is_admin = true;
    function test_create_item(
        stream_name,
        current_items,
        expected_item,
        stream_prefix_required = true,
        get_allowed_streams = stream_data.get_unsorted_subs,
    ) {
        const item = stream_pill.create_item_from_stream_name(
            stream_name,
            current_items,
            stream_prefix_required,
            get_allowed_streams,
        );
        assert.deepEqual(item, expected_item);
    }

    test_create_item("sweden", [], undefined);
    test_create_item("#sweden", [sweden_pill], undefined);
    test_create_item("  #sweden", [], sweden_pill);
    test_create_item("#test", [], undefined);
    test_create_item("#germany", [], undefined, true, stream_data.get_invite_stream_data);
});

run_test("get_stream_id", () => {
    assert.equal(stream_pill.get_stream_name_from_item(denmark_pill), denmark.name);
});

run_test("get_user_ids", () => {
    const items = [denmark_pill, sweden_pill];
    const widget = {items: () => items};

    const user_ids = stream_pill.get_user_ids(widget);
    assert.deepEqual(user_ids, [1, 2, 3, 4, 5, 77]);
});

run_test("get_stream_ids", () => {
    const items = [denmark_pill, sweden_pill];
    const widget = {items: () => items};

    const stream_ids = stream_pill.get_stream_ids(widget);
    assert.deepEqual(stream_ids, [101, 102]);
});
