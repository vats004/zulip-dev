"use strict";

const {strict: assert} = require("assert");

const {zrequire} = require("./lib/namespace");
const {run_test} = require("./lib/test");
const {current_user, realm} = require("./lib/zpage_params");

const bot_data_params = {
    realm_bots: [
        {
            api_key: "QadL788EkiottHmukyhHgePUFHREiu8b",
            avatar_url: "",
            bot_type: 1, // DEFAULT_BOT
            default_all_public_streams: true,
            default_events_register_stream: "register stream 1",
            default_sending_stream: "sending stream 1",
            email: "error-bot@zulip.org",
            full_name: "Error bot",
            is_active: true,
            owner: "someone 4",
            owner_id: 4,
            user_id: 1,
            services: [],
            extra: "This field should be ignored",
        },
    ],
};

const bot_data = zrequire("bot_data");
const settings_bots = zrequire("settings_bots");

bot_data.initialize(bot_data_params);

function test(label, f) {
    run_test(label, ({override}) => {
        realm.realm_url = "https://chat.example.com";
        realm.realm_embedded_bots = [
            {name: "converter", config: {}},
            {name: "giphy", config: {key: "12345678"}},
            {name: "foobot", config: {bar: "baz", qux: "quux"}},
        ];

        f({override});
    });
}

test("generate_zuliprc_url", () => {
    const url = settings_bots.generate_zuliprc_url(1);
    const expected =
        "data:application/octet-stream;charset=utf-8," +
        encodeURIComponent(
            "[api]\nemail=error-bot@zulip.org\n" +
                "key=QadL788EkiottHmukyhHgePUFHREiu8b\n" +
                "site=https://chat.example.com\n",
        );

    assert.equal(url, expected);
});

test("generate_zuliprc_content", () => {
    const bot_user = bot_data.get(1);
    const content = settings_bots.generate_zuliprc_content(bot_user);
    const expected =
        "[api]\nemail=error-bot@zulip.org\n" +
        "key=QadL788EkiottHmukyhHgePUFHREiu8b\n" +
        "site=https://chat.example.com\n";

    assert.equal(content, expected);
});

test("generate_botserverrc_content", () => {
    const user = {
        email: "vabstest-bot@zulip.com",
        api_key: "nSlA0mUm7G42LP85lMv7syqFTzDE2q34",
    };
    const service = {
        token: "abcd1234",
    };
    const content = settings_bots.generate_botserverrc_content(
        user.email,
        user.api_key,
        service.token,
    );
    const expected =
        "[]\nemail=vabstest-bot@zulip.com\n" +
        "key=nSlA0mUm7G42LP85lMv7syqFTzDE2q34\n" +
        "site=https://chat.example.com\n" +
        "token=abcd1234\n";

    assert.equal(content, expected);
});

test("can_create_new_bots", () => {
    current_user.is_admin = true;
    assert.ok(settings_bots.can_create_new_bots());

    current_user.is_admin = false;
    realm.realm_bot_creation_policy = 1;
    assert.ok(settings_bots.can_create_new_bots());

    realm.realm_bot_creation_policy = 3;
    assert.ok(!settings_bots.can_create_new_bots());
});
