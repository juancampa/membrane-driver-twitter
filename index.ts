// `nodes` contain any nodes you add from the graph (dependencies)
// `root` is a reference to this program's root node
// `state` is an object that persist across program updates. Store data here.
import { root, state, nodes } from "membrane";
import { api, parseQS, getBearerToken, shouldFetch } from "./util";

state.idsByUsernames = state.idsByUsernames ?? {};

export const Root = {
  parse({ args: { name, value } }) {
    switch (name) {
      case "tweet": {
        // TODO: parse tweet url
        const url = new URL(value);
        const [, user, , tweet] = url.pathname.split("/");
        return [root.tweets.one({ id: tweet })];
      }
      case "user": {
        const [user] = value.match(/\w{1,15}/g);
        
        return [root.user({ username: user })];
      }
    }
  },
  status() {
    if (!state.client_id || !state.client_secret) {
      return "Please get [OAuth 2.0 Client ID, Client Secret](https://developer.twitter.com/en/portal) and configure.";
    } else if (!state.refreshToken) {
      return `Please [authenticate with Twitter](${state.endpointUrl})`;
    } else {
      return `Ready`;
    }
  },
  user: async ({ args: { username, id }, info, context }) => {
    if (username) {
      if (state.idsByUsernames[username]) {
        id = state.idsByUsernames[username];
      } else {
        const res = await api("GET", `2/users/by/username/${username}`);
        const { data } = await res.json();
        id = data.id;
        state.idsByUsernames[username] = id;
      }
    }
    context.userId = id;
    if (
      !shouldFetch(info, ["id", "tweets", "followers", "mentions", "likes"])
    ) {
      return { id };
    }
    
    const res = await api("GET", `2/users/by/username/${username}`);
    const { data } = await res.json();
    return data;
  },
  configure: async ({ args: { CLIENT_ID, CLIENT_SECRET } }) => {
    state.endpointUrl = state.endpointUrl ?? (await nodes.endpoint.$get());
    state.client_id = CLIENT_ID;
    state.client_secret = CLIENT_SECRET;
  },
  tweet: async ({ args }) => {
    let poll;
    if (args.poll_options && args.poll_duration_minutes) {
      poll = {
        // poll options must be comma separated
        options: args.poll_options.split(","),
        duration_minutes: args.poll_duration_minutes,
      };
    }

    const data = {
      text: args.text,
      ...(poll && { poll }),
    };
    JSON.stringify(
      await api("POST", "2/tweets", {}, JSON.stringify({ ...data }))
    );
  },
  tweets: () => ({}),
};

export const TweetCollection = {
  async one({ args: { id } }) {
    const res = await api("GET", `2/tweets/${id}`);

    return await res.json().then((json: any) => json && json.data);
  },
  async page({ self, args, context }) {
    let path = "2/tweets/search/recent";
    const { userId: id } = context;
    if (id) {
      path = `2/users/${id}/tweets`;
    }
    const res = await api("GET", path, args);
    const { data, meta } = await res.json();

    const next = self.page({ ...args, pagination_token: meta.next_token });
    return { items: data, next };
  },
};

export const FollowersCollection = {
  async page({ self, args, context }) {
    const { userId: id } = context;
    const res = await api("GET", `2/users/${id}/followers`, args);
    const { data, meta } = await res.json();

    const next = self.page({ ...args, pagination_token: meta.next_token });
    return { items: data, next };
  },
};

export const MentionsCollection = {
  async page({ self, args, context }) {
    const { userId: id } = context;
    const res = await api("GET", `2/users/${id}/mentions`, args);
    const { data, meta } = await res.json();

    const next = self.page({ ...args, pagination_token: meta.next_token });
    return { items: data, next };
  },
};

export const LikedCollection = {
  async page({ self, args, context }) {
    const { userId: id } = context;
    const res = await api("GET", `2/users/${id}/liked_tweets`, args);
    const { data, meta } = await res.json();

    const next = self.page({ ...args, pagination_token: meta.next_token });
    return { items: data, next };
  },
};

export const LikingCollection = {
  async page({ self, args }) {
    const { id } = self.$argsAt(root.user.tweets.one);
    const res = await api("GET", `2/tweets/${id}/liking_users`, args);
    const { data, meta } = await res.json();

    const next = self.page({ ...args, pagination_token: meta.next_token });
    return { items: data, next };
  },
};

export const Tweet = {
  gref: ({ obj, self }) => {
    const { username } = self.$argsAt(root.user);
    if (username) {
      return root.user({ username }).tweets.one({ id: obj.id });
    }
    return root.tweets.one({ id: obj.id });
  },
  likingUsers: () => ({}),
};

export const User = {
  gref: ({ obj }) => {
    return root.user({ username: obj.username });
  },
  tweets: () => ({}),
  followers: () => ({}),
  mentions: () => ({}),
  liked: () => ({}),
};

export async function endpoint({ args: { path, query, headers, body } }) {
  switch (path) {
    case "/": {
      return `<a href="/auth">Authenticate with Twitter</a>`;
    }
    case "/auth":
    case "/auth/": {
      state.code_challenge = "membrane"; // TODO: generateCodeChallenge();
      const scope =
        "tweet.read tweet.write users.read follows.read follows.write like.read like.write offline.access";
      return JSON.stringify({
        status: 303,
        headers: {
          location: `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${
            state.client_id
          }&redirect_uri=${encodeURIComponent(
            state.endpointUrl
          )}/callback&scope=${encodeURIComponent(
            scope
          )}&state=state&code_challenge=${
            state.code_challenge
          }&code_challenge_method=plain`,
        },
      });
    }
    case "/callback": {
      const { code } = parseQS(query);
      const { access_token, refresh_token } = await getBearerToken(
        "access",
        code
      );
      if (access_token) {
        state.accessToken = access_token;
        state.refreshToken = refresh_token;
        return "Twitter driver configured correctly";
      }
      return "Error";
    }
    default:
      console.log("Unknown Endpoint:", path);
  }
}
