import Activity from "./models/activity";
import FeedGroup from "./models/feed_group";
import Feed from "./models/feed";
import ActivityFeed from "./models/activity_feed";
import Follow from "./models/follow";
import chunkify from "./utils/chunk";
import Redlock from "redlock";
import Queue from "bull";

export const OPERATIONS = { ADD_OPERATION: 1, REMOVE_OPERATION: 2 };

const updateOptions = { upsert: true, new: true };

export class FeedManager {
  constructor(mongoConnection, redisConnection, options) {
    this.mongoConnection = mongoConnection;
    this.redisConnection = redisConnection;
    this.redlock = this._createLock();
    this.queue = new Queue("activity feed", redisConnection);
    if (!options) {
      options = {};
    }
    const defaultOptions = { bull: false };
    this.options = { ...defaultOptions, ...options };
  }

  async follow(source, target) {
    const lock = await this.redlock.lock(`followLock${source._id}`, 10 * 1000);

    // create the follow relationship
    const follow = await Follow.findOneAndUpdate(
      { source, target },
      { source, target },
      updateOptions
    );

    // get the activity references
    const activityReferences = await ActivityFeed.find({ feed: target })
      .limit(300)
      .sort("-time");

    // write these to the source feed
    const operations = [];
    for (const reference of activityReferences) {
      let document = reference.toObject();
      document._id = null;
      document.feed = source;
      operations.push({ insertOne: { document } });
    }
    // call the bulk create
    if (operations.length >= 1) {
      await ActivityFeed.bulkWrite(operations, { ordered: false });
    }
    await lock.unlock();
  }

  async unfollow(source, target) {
    const lock = await this.redlock.lock(`followLock${source._id}`, 10 * 1000);

    // create the follow relationship
    const follow = await Follow.findOneAndDelete({ source, target });

    // remove the activities with the given origin
    const activityReferences = await ActivityFeed.remove({
      feed: source,
      origin: target
    });

    await lock.unlock();
  }

  async addOrRemoveActivity(activityData, feed, operation) {
    // create the activity
    let { actor, verb, object, target, time, ...extra } = activityData;
    if (!time) {
      time = new Date();
    }
    const values = {
      actor: actor,
      verb: verb,
      object: object,
      target: target,
      time: time,
      extra: extra
    };
    const activity = await Activity.findOneAndUpdate(values, values, {
      upsert: true,
      new: true
    });

    // create the activity feed for the primary feed
    const activityFeed = await ActivityFeed.create({
      feed: feed,
      activity: activity,
      operation: operation,
      time: activity.time,
      origin: feed
    });

    // fanout to the followers in batches
    const followers = await Follow.find({ target: feed })
      .select("source")
      .lean();
    const groups = chunkify(followers, 500);
    let origin = feed;
    for (const group of groups) {
      if (this.options.bull) {
        this.queue.add({ activity, group, origin, operation });
      } else {
        await this._fanout(activity, group, origin, operation);
      }
    }
    return activity;
  }

  async _fanout(activity, group, origin, operation) {
    let operations = [];
    for (const follow of group) {
      let document = {
        feed: follow.source,
        activity: activity,
        operation: operation,
        time: activity.time,
        origin
      };
      operations.push({ insertOne: { document } });
    }
    if (operations.length >= 1) {
      await ActivityFeed.bulkWrite(operations, { ordered: false });
    }
  }

  async readFeed(feed, limit) {
    // read the feed sorted by the activity time
    const operations = await ActivityFeed.find({ feed })
      .sort({ time: -1, operationTime: -1 })
      .limit(1000);
    // next order by the operationTime to handle scenarios where people add/remove
    operations.sort((a, b) => {
      return b.operationTime - a.operationTime;
    });
    // TODO: there are edge cases here with add/remove on older activities
    // For example if you add 1 activity with a recent time 500 times and remove it 500 times.
    // Next you add an activity with an older time
    // the feed will show up empty
    const seen = {};
    const activities = [];
    for (const activityOperation of operations) {
      if (activityOperation.activity in seen) {
        // ignore
      } else {
        if (activityOperation.operation == OPERATIONS.ADD_OPERATION) {
          activities.push(activityOperation.activity);
        }
        seen[activityOperation.activity] = true;
      }
    }
    return activities.slice(0, limit);
  }

  async getOrCreateFeed(name, feedID) {
    const group = await FeedGroup.findOneAndUpdate(
      { name },
      { name },
      updateOptions
    );
    const feed = await Feed.findOneAndUpdate(
      { group: group, feedID },
      { group: group, feedID },
      updateOptions
    );
    return feed;
  }

  async addActivity(activityData, feed) {
    return this.addOrRemoveActivity(
      activityData,
      feed,
      OPERATIONS.ADD_OPERATION
    );
  }

  async removeActivity(activityData, feed) {
    return this.addOrRemoveActivity(
      activityData,
      feed,
      OPERATIONS.REMOVE_OPERATION
    );
  }

  _createLock() {
    let redlock = new Redlock(
      // you should have one client for each independent redis node
      // or cluster
      [this.redisConnection],
      {
        // the expected clock drift; for more details
        // see http://redis.io/topics/distlock
        driftFactor: 0.01, // time in ms

        // the max number of times Redlock will attempt
        // to lock a resource before erroring
        retryCount: 3,

        // the time in ms between attempts
        retryDelay: 300, // time in ms

        // the max time in ms randomly added to retries
        // to improve performance under high contention
        // see https://www.awsarchitectureblog.com/2015/03/backoff.html
        retryJitter: 200 // time in ms
      }
    );
    return redlock;
  }
}