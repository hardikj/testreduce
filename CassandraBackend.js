var util = require('util'),
    events = require('events'),
    cass = require('node-cassandra-cql'),
    consistencies = cass.types.consistencies,
    uuid = require('node-uuid'),
    PriorityQueue = require('priorityqueuejs'),
    async = require('async');

function tidFromDate(date) {
    // Create a new, deterministic timestamp
    return uuid.v1({
        node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab],
        clockseq: 0x1234,
        msecs: date.getTime(),
        nsecs: 0
    });
}

// Constructor
function CassandraBackend(name, config, callback) {
    var self = this;

    this.name = name;
    this.config = config;
    // convert consistencies from string to the numeric constants
    var confConsistencies = config.backend.options.consistencies;
    this.consistencies = {
        read: consistencies[confConsistencies.read],
        write: consistencies[confConsistencies.write]
    };

    self.client = new cass.Client(config.backend.options);

    var reconnectCB = function (err) {
        if (err) {
            // keep trying each 500ms
            console.error('pool connection error, scheduling retry!');
            setTimeout(self.client.connect.bind(self.client, reconnectCB), 500);
        }
    };
    this.client.on('connection', reconnectCB);
    this.client.connect();

    var numFailures = config.numFailures;

    self.commits = [];
    self.testQueue = new PriorityQueue(function (a, b) {
        return a.score - b.score;
    });
    self.runningQueue = [];
    self.testsList = {};
    self.latestRevision = {};
    self.testScores = [];
    self.topFailsArray = [];
    self.testByScoreToCommit = [];
    self.latestResults = {};

    self.tasks =[getCommits.bind(this), initLatestResults.bind(this), getTests.bind(this), initTestPQ.bind(this), initTopFails.bind(this)];
    // Load all the tests from Cassandra - do this when we see a new commit hash

    async.waterfall(self.tasks, function (err, result) {
        if (err) {
            console.log('failure in setup', err);
        }
        console.log('in memory queue setup complete');
        self.topFailsArray.sort(function(a,b){
            return b.score - a.score;
        });
        //console.log("res: " + JSON.stringify(result,null,'\t'));
    });

    callback();
}

// cb is getTests

//I did :
// insert into commits (hash, tid, keyframe) values (textAsBlob('0b5db8b91bfdeb0a304b372dd8dda123b3fd1ab6'), 5b89fc70-ba95-11e3-a5e2-0800200c9a66, true);
// insert into commits (hash, tid, keyframe) values (textAsBlob('bdb14fbe076f6b94444c660e36a400151f26fc6f'), d0602570-b52b-11e3-a5e2-0800200c9a66, true);
function getCommits(cb) {
    var queryCB = function (err, results) {
        if (err) {
            cb(err);
        } else if (!results || !results.rows) {
            //console.log( 'no seen commits, error in database' );
            cb("no seen commits, error in database");
        } else {
            for (var i = 0; i < results.rows.length; i++) {
                var commit = results.rows[i];
                // commits are currently saved as blobs, we shouldn't call toString on them...
                // commit[0].toString()
                this.commits.push({
                    hash: commit['hash'].toString(),
                    timestamp: commit['dateOf(tid)'],
                    isKeyframe: commit['keyframe']
                });
            }

            this.commits.sort(function (a, b) {
                 var d1 = new Date(a.timestamp);
                var d2 = new Date(b.timestamp);
                return d2 > d1;
            });
            //console.log("commits: " + JSON.stringify(this.commits, null,'\t'));
            cb(null);
        }
    };

    // get commits to tids
    var cql = 'select hash, dateOf(tid), keyframe from commits';
    this.client.execute(cql, [], this.consistencies.write, queryCB.bind(this));
}

function initLatestResults(cb) {
    if (!this.commits.length) {
        return cb(null);
    }

    var lastCommit = this.commits[0] && this.commits[0].hash.toString();
    var skips = {}, cql, fails = {};

    if (this.commits.length === 1) {
        var queryCB = function (err, results) {
            if (err) {
                console.log("err: " + err);
                cb(err);
            } else if (!results || !results.rows) {
                cb(null);
            } else {
                results.rows.forEach(function(item) {
                    var data = item['score'];
                    var counts = countScore(data);
                    if (!skips[counts.skips]) {
                        skips[counts.skips] = 1;
                    } else {
                        skips[counts.skips] += 1;
                    }
                    if (!fails[counts.fails]) {
                        fails[counts.fails] = 1;
                    } else {
                        fails[counts.fails]++;
                    }
                });
                this.latestResults[lastCommit] = {};
                this.latestResults[lastCommit].skips = skips;
                this.latestResults[lastCommit].fails = fails;
            }
        };
        // since only one commit in db, skips/fails stats can be computed with current commit
        cql = 'select score from test_by_score where commit = ?';
        this.client.execute(cql, [lastCommit], this.consistencies.write, queryCB.bind(this));
    } else {
        // fill this by latest results
        cql = 'select skipstats, failstats from revision_summary where revision = ?';
        var queryCB2 = function (err, results) {
            if (err) {
                console.log("err: " + err);
                cb(err);
            } else if (!results || !results.rows) {
                cb(null);
            } else {
                results.rows.forEach(function(item) {
                    var data = item['score'];
                    var counts = countScore(data);
                    if (!skips[counts.skips]) {
                        skips[counts.skips] = 1;
                    } else {
                        skips[counts.skips] += 1;
                    }
                    if (!fails[counts.fails]) {
                        fails[counts.fails] = 1;
                    } else {
                        fails[counts.fails]++;
                    }
                });
            this.latestResults[lastCommit].skips = skips;
            this.latestResults[lastCommit].fails = fails;
            }
        };
        var queryCB1 =  function (err, results) {
            if (err) {
                console.log("err: " + err);
                cb(err);
            } else if (!results || !results.rows[0]) {
                cql = 'select score from test_by_score where commit = ?';
                var secondLastCommit = this.commits[1].hash.toString();
                this.client.execute(cql, [secondLastCommit], this.consistencies.write, queryCB2.bind(this));
            } else {
                this.latestResults[lastCommit].skips = results.rows[0].skipstats;
                this.latestResults[lastCommit].fails = results.rows[0].failstats;
            }
        };
        this.client.execute(cql, [lastCommit], this.consistencies.write, queryCB1.bind(this));
    }
    cb(null);
}

// cb is initTestPQ
function getTests(cb) {
    var queryCB = function (err, results) {
        if (err) {
            cb(err);
        } else if (!results || !results.rows) {
            console.log('no seen commits');
            cb(null, 0, 0);
        } else {
            // I'm not sure we need to have this, but it exists for now till we decide not to have it.
            for (var i = 0; i < results.rows.length; i++) {
                this.testsList[results.rows[i]] = true;
            }
            cb(null, 0, results.rows.length);
        }
    };

    // get tests
    var cql = 'select test from tests;';

    // And finish it off
    this.client.execute(cql, [], this.consistencies.write, queryCB.bind(this));
}

//note to the person doing inittestpq, this function will call cb(null) twice
//the line after checking if we have no tests left
function initTestPQ(commitIndex, numTestsLeft, cb) {
    var queryCB = function (err, tests, results) {
        if (err) {
            console.log('in error init test PQ');
            cb(err);
        } else if (!tests || !tests.rows || tests.rows.length === 0) {
            console.log("no tests");
            cb(null);
        } else {
            var resultsMap = {}, i;

            if (!results || !results.rows || results.rows.length === 0) {
                results = {rows:[]};
            } else {
                for (i=0; i < results.rows.length; i++) {
                    resultsMap[results.rows[i]['test'].toString('base64')] = true;
                }
            }

            var inResults = false;
            for (i = 0; i < tests.rows.length; i++) {
                var test = tests.rows[i];
                if (!resultsMap[test['test'].toString('base64')]) {
                    this.testQueue.enq({
                        test: test['test'],
                        score: test['score'],
                        commit: test['commit'].toString(),
                        failCount: 0
                    });
                }
                this.testScores[test['commit'].toString()] = test['commit'];
                this.testByScoreToCommit.push(test['commit']);
            }

            if (numTestsLeft === 0 || !this.commits.length ||
                this.commits[commitIndex].isKeyframe) {
                cb(null);
            }

			console.log('left', commitIndex, this.commits.length);
            if (numTestsLeft - tests.rows.length > 0 &&
                commitIndex < this.commits.length - 1) {
                var redo = initTestPQ.bind(this);
                return redo(commitIndex + 1, numTestsLeft - tests.rows.length, cb);
            }
            cb(null);
        }
    };

    var queryCB1 = function(err, results) {
        var cql = 'select test from tests',
            self = this;

        this.client.execute(cql, null, this.consistencies.write, function (err, tests) {
            if(err) {
                cb(err);
            }

            // add score and commit entries
            tests.rows.forEach(function(row) {
                row['score'] = 0; // score
                row['commit'] = ''; // commit
            });
            queryCB.call(self, err, tests, results);
        });
    };

    var queryCB2 = function(err, results, lastCommit) {
        var cql = 'select test, score, commit from test_by_score where commit = ?';
        this.client.execute(cql, [lastCommit], this.consistencies.write, queryCB.bind(this));
    };

    var lastCommit = this.commits[commitIndex] && this.commits[commitIndex].hash;
    this.latestRevision.commit = lastCommit;

    var cql = 'select test from results where tid = ?',
        self = this,
        latestCommit = '';
    if (this.commits.length) {
        latestCommit = tidFromDate(this.commits[0].timestamp).toString();
    }
    this.client.execute(cql, [latestCommit], this.consistencies.write, function (err, result) {
        if(err) {
            cb(err);
        }

        //XXX change the if condition below to !lastCommit later when test_by_score is not empty
        if (true) {
            queryCB1.call(self, err, result);
        } else {
            console.log('lastCommit', lastCommit.toString(), '@', commitIndex);
            queryCB2.call(self, err, result, lastCommit);
        }
    });
}

function initTopFails(cb) {
	if (!this.commits.length) {
		return cb(null);
	}

    var queryCB = function (err, results) {
        if (err) {
            console.log('error in init top fails');
            cb(err);
        } else if (!results || !results.rows || results.rows.length === 0) {
            console.log("no results found in initTopFails");
            cb(null);
        } else {
            for (var i = 0; i < results.rows.length; i++) {
                var result = results.rows[i];
                var index = findWithAttr(this.topFailsArray, "test", result['test']);
                if (index === -1 || this.topFailsArray === undefined ) {
                    this.topFailsArray.push({ test: result['test'], score: result['score'], commit: result['commit'].toString()});
                } else if(this.topFailsArray[index].score <= result['score']) {
                    this.topFailsArray[index] ={ test: result['test'], score: result['score'], commit: result['commit'].toString()};
                }
            }

            this.commitFails++;
            if (this.commitFails < this.commits.length) {
                var redo = initTopFails.bind( this );
                redo(cb);
            } else {
              cb(null, this.topFailsArray);
            }
        }
    };
    this.commitFails = (this.commitFails !== undefined) ? this.commitFails :  0;
    //console.log("this.commits[0]: " + this.commitFails + "is "  + JSON.stringify(this.commits[0]));

    if(!this.commits[this.commitFails]) {
        //console.log("finished!: " + this.commitFails + "stuff: " + JSON.stringify(this.topFailsArray, null,'\t'));
        console.log("ran out of commits??");
        return cb(null);
    }
    var lastCommit = this.commits[this.commitFails].hash;
        lastHash = lastCommit && lastCommit.hash || '';
    //console.log("commit table: " + JSON.stringify(this.commits, null,'\t'));
    if (!lastCommit) {
      var error = "no last commit";
      //console.log("no last commit");
      cb(error);
    }
    var cql = 'select test, score, commit from test_by_score where commit = ?';

    this.client.execute(cql, [lastCommit], this.consistencies.write, queryCB.bind( this ));
}

function findWithAttr(array, attr, value) {
    for(var i = 0; i < array.length; i++) {
        //console.log("finding: " + typeof(array[i].test) + " comparing: " + typeof(value));
        if(array[i][attr].toString() === value.toString()) {
            //console.log("found!")
            return i;
        }
    }
    return -1;
}

CassandraBackend.prototype.getTFArray = function(cb) {
    if(!this.topFailsArray || this.topFailsArray.length === 0) {
        return cb("empty or nonexistent array");
    } else {

        return cb(null, this.topFailsArray);
    }
};

/**
 * Get the number of regressions based on the previous commit
 *
 * @param commit1 object {
 *  hash: <git hash string>
 *  timestamp: <git commit timestamp date object>
 * }
 * @param cb function (err, num) - num is the number of regressions for the last commit
 */
CassandraBackend.prototype.getNumRegressions = function (commit, cb) {
    var fakeNum = 3;
    cb(null, fakeNum);
};

CassandraBackend.prototype.removePassedTest = function (testName) {
    for (var i = 0; i < this.runningQueue.length; i++) {
        if (this.runningQueue[i].test === testName) {
            this.runningQueue.splice(i, 1);
            break;
        }
    }
};

CassandraBackend.prototype.getTestToRetry = function () {
    for (var i = 0, len = this.runningQueue.length, currTime = new Date(); i < len; i++) {
        var job = this.runningQueue[this.runningQueue.length - 1];
        if ((currTime.getMinutes() - job.startTime.getMinutes()) > 10) {
            this.runningQueue.pop();
            if (job.test.failCount < this.numFailures) {
                job.test.failCount++;
                return job;
            } else {
                // write failed test into cassandra data store
            }
        } else {
            break;
        }
    }
    return undefined;
};

CassandraBackend.prototype.updateCommits = function (lastCommitTimestamp, commit, date) {
    if (lastCommitTimestamp < date) {
        this.commits.unshift({
            hash: commit,
            timestamp: date,
            isKeyframe: false
        });
        cql = 'insert into commits (hash, tid, keyframe) values (?, ?, ?);';

        args = [new Buffer(commit), tidFromDate(date), false];
        this.client.execute(cql, args, this.consistencies.write, function (err, result) {
            if (err) {
                console.log(err);
            }
        });
        self = this;

        if (this.latestResults[commit]) {
            this.latestResults[commit] = {};
            skips = {value: this.latestResults[commit].skips, hint: 'map'};
            fails = {value: this.latestResults[commit].fails, hint: 'map'};
        } else if(this.commits.length >1){
            this.latestResults[commit] = {};
            this.latestResults[commit].skips = this.latestResults[this.commits[1].hash].skips;
            this.latestResults[commit].fails = this.latestResults[this.commits[1].hash].fails;
            skips = {value: this.latestResults[this.commits[1].hash].skips, hint: 'map'};
            fails = {value: this.latestResults[this.commits[1].hash].fails, hint: 'map'};
        } else {
            this.latestResults[commit] = {};
            skips = {value: {}, hint: 'map'};
            fails = {value: {}, hint: 'map'};
            this.latestResults[commit].skips = {};
            this.latestResults[commit].fails = {};
        }

        this.getStatistics(function (err, result) {
            cql = 'insert into revision_summary (revision, errors, skips, fails, numtests, skipstats, failstats) values (?, ? , ? , ?, ?, ?, ?);';
            args = [new Buffer(commit), result.averages.errors, result.averages.skips, result.averages.fails, result.averages.numtests, skips, fails];
            self.client.execute(cql, args, self.consistencies.write, function(err, result) {
                if (err) {
                    console.log(err);
                }
            });
        });
    }
};

/**
 * Get the next test to run
 *
 * @param commit object {
 * hash: <git hash string>
 * timestamp: <git commit timestamp date object>
 * }
 * @param cb function (err, test) with test being an object that serializes to
 * JSON, for example [ 'enwiki', 'some title', 12345 ]
 */
CassandraBackend.prototype.getTest = function (clientCommit, clientDate, cb) {
    var retry = this.getTestToRetry(),
        lastCommitTimestamp = new Date(0),
        retVal = {
            error: {
                code: 'ResourceNotFoundError',
                messsage: 'No tests to run for this commit'
            }
        };

	lastCommitTimestamp = this.commits[0] && this.commits[0].timestamp || new Date(0);

    this.updateCommits(lastCommitTimestamp, clientCommit, clientDate);

    if (lastCommitTimestamp && lastCommitTimestamp > clientDate) {
        retVal = {
            error: {
                code: 'BadCommitError',
                message: 'Commit too old'
            }
        };
    } else if (retry) {
        retVal = {
            test: retry
        };
    } else if (this.testQueue.size()) {
        var test = this.testQueue.deq();
        //ID for identifying test, containing title, prefix and oldID.
        this.runningQueue.unshift({
            test: test,
            startTime: new Date()
        });
        retVal = {
            test: test.test
        };
    }
    cb(retVal);
};


/**
Computes the number of regression and fixes based on deltas
**/
CassandraBackend.prototype.getNumRegFix = function(r1, r2, cb) {
  var calc = calcRegressionFixes.bind(this), res;
  if ( r2 ) {
      calc(r1, r2, function (err, regressions, fixes) {
        if (err) {
            console.log(err);
            res = {
                reg: 0,
                fix: 0
            };
            cb(err, res);
        } else {
            res = {
                reg: regressions.length,
                fix: fixes.length
            };
            cb(null, res);
        }
      });
  } else {
      var args = [];
      var cql = "select delta from test_by_score where commit = ?";
      args = args.concat([this.latestRevision.commit]);

      this.client.execute(cql, args, this.consistencies.write,function(err, results) {
        if (err) {
            console.log("err: " + err);
            cb(err);
        } else if (!results || !results.rows) {
            console.log('no seen commits, error in database');
            cb(null);
        } else {
          var data = results.rows;
          var res = {
            reg: 0,
            fix: 0
          };
          //console.log("data: " + JSON.stringify(data,null,'\t'));
          for(var y in data) {
            if(data[y][0] > 0) {
                res.reg++;
            } else if(data[y][0] < 0) {
                res.fix++;
            }
          }
          cb(null, res);
        }
      });
    }
};

/**
 * Get results ordered by score
 *
 * @param cb- (err, result), result is defined below
 *

*/

CassandraBackend.prototype.getStatistics = function (cb) {

    /**
     * @param result
     *  Required results:
        numtests-
        noerrors- numtests - ()
        noskips- ()
        nofails
        latestcommit
        crashes
        beforelatestcommit
        numfixes
        numreg
     *

    how to compute a commit summary just by test_by_scores
    1) use a commit and search through all test_by_scores
    2) compute the amount of errors, skips, and fails
    num tests = num quered
        - Go through each, and for every tests
          If(score == 0) then noerrors++ ; nofails++; noskips++;
          else IF(score > 1000000) -> do nothing
          else If(score > 1000) (it's a fail = noskips++)
          else If(score > 0 ) (it's a skip = noerrors++; no fails++)
    3) We have latest commit, num tests and For now,
    just mock the data for numreg, numfixes, and crashes and latest commit


    insert into test_by_score (commit, delta, test, score) values (textAsBlob('0b5db8b91bfdeb0a304b372dd8dda123b3fd1ab6'), 0, textAsBlob('{"prefix": "enwiki", "title": "\"Slonowice_railway_station\""}'), 28487);
    insert into test_by_score (commit, delta, test, score) values (textAsBlob('0b5db8b91bfdeb0a304b372dd8dda123b3fd1ab6'), 0, textAsBlob('{"prefix": "enwiki", "title": "\"Salfoeld\""}'), 192);
    insert into test_by_score (commit, delta, test, score) values (textAsBlob('0b5db8b91bfdeb0a304b372dd8dda123b3fd1ab6'), 0, textAsBlob('{"prefix": "enwiki", "title": "\"Aghnadarragh\""}'), 10739);

    insert into test_by_score (commit, delta, test, score) values (textAsBlob('bdb14fbe076f6b94444c660e36a400151f26fc6f'), 0, textAsBlob('{"prefix": "enwiki", "title": "\"Slonowice_railway_station\""}'), 10500);
    insert into test_by_score (commit, delta, test, score) values (textAsBlob('bdb14fbe076f6b94444c660e36a400151f26fc6f'), 0, textAsBlob('{"prefix": "enwiki", "title": "\"Salfoeld\""}'), 1050);
    insert into test_by_score (commit, delta, test, score) values (textAsBlob('bdb14fbe076f6b94444c660e36a400151f26fc6f'), 0, textAsBlob('{"prefix": "enwiki", "title": "\"Aghnadarragh\""}'), 100);
    */

    //console.log('getStatistics', commit.toString());
    commit = this.commits.length && this.commits[this.commits.length - 1].hash || "";

    var getRegFixes = this.getNumRegFix.bind(this);
    var generateStatsCB = function (err, results) {
        if (err) {
            console.log("err: " + err);
            cb(err);
        } else if (!results || !results.rows) {
            console.log('no seen commits, error in database');
            cb(null);
        } else if(!results.rows.length) {
            averages = {
                errors: null,
                fails: null,
                skips: null,
                score: null,
                numtests: results.rows.length
            };
            cb (null, {
                    numtests: results.rows.length,
                    noerrors: 0,
                    noskips: 0,
                    nofails: 0,
                    latestcommit: 'unavailable',
                    numReg: 0,
                    numFixes: 0,
                    averages: averages
            });
        } else {

            // console.log("hooray we have data!: " + JSON.stringify(results.rows, null,'\t'));
            var numtests = results.rows.length;
            getRegFixes(commit.toString(), sndToLastCommit, function (err, data) {
                if (err) {
                    cb(err);
                }
                extractESF(results.rows, function (err, ESFdata) {
                    var averages = {
                        errors: ESFdata.errors / numtests,
                        fails: ESFdata.fails / numtests,
                        skips: ESFdata.skips / numtests,
                        score: ESFdata.totalscore / numtests,
                        numtests: numtests
                    };
                    var results = {
                        numtests: numtests,
                        noerrors: ESFdata.noerrors,
                        noskips: ESFdata.noskips,
                        nofails: ESFdata.nofails,
                        latestcommit: commit.toString(),
                        beforelatestcommit: sndToLastCommit,
                        numReg: data.reg,
                        numFixes: data.fix,
                        averages: averages
                    };
                    cb(null, results);
                });
            });
        }
    };

    //if it's not the latest revision AND latestRevision isn't empty,
    //then we can just look it up in the revision summary table

    //else if it's the latest revision, we have to dynamically compute it and then insert
    var args = [],
        results = {},
        sndToLastCommit = "",
        self = this;

    var execLatestCommits = returnLatestCommit.bind(this);
    //first take the 2nd to last revision from the commits array
    execLatestCommits(function (err, com1, com2) {
        if (err) {
            return cb(err);
        } else {
            commit = com1;
            if (com2) //com2 may not exist
                sndToLastCommit = com2;
            //else if it's the latest revision, we have to dynamically compute it and then insert
            var cql = "select score from test_by_score where commit = ?";
            args = args.concat([commit]);

            var shouldExec = true;
            if (self.testQueue.length && self.testQueue.peek().commit === commit.toString()) {
                shouldExec = false;
            }

            if (shouldExec)
                self.client.execute(cql, [commit], self.consistencies.write, generateStatsCB.bind(self));
            else {
                var results = {};
                results.rows = self.testByScoreToCommit;
                var noQueryGen = generateStatsCB.bind(self);
                console.log("no additional query needed");
                return noQueryGen(null, results);
            }
            //var results = {};
        }
    });
};

var extractESF = function (rows, cb) {
    var noerrors = 0,
        nofails = 0,
        noskips = 0;
    var errors = 0, fails = 0, skips = 0;
    var totalscore = 0;

    async.each(rows, function (item, callback) {
        var data = item.score; //|| item;
        if (data < 1000000) {
            if (data === 0) {
                noerrors++;
                noskips++;
                nofails++;
            } else if (data > 1000) {
                noerrors++;
            } else if (data > 0) {
                noerrors++;
                nofails++;
            }
        }
        var counts = countScore(data);
        errors += counts.errors;
        fails += counts.fails;
        skips += counts.skips;
        totalscore += data;
        callback();
    }, function (err) {
        results = {
            noerrors: noerrors,
            noskips: noskips,
            nofails: nofails,
            errors: errors,
            fails: fails,
            skips: skips,
            totalscore: totalscore,
        };
        //console.log("result: " + JSON.stringify(results, null,'\t'));
        cb(null, results);

    });
};
/**
 * Add a result to storage
 *
 * @param test string representing what test we're running
 * @param commit object {
 *    hash: <git hash string>
 *    timestamp: <git commit timestamp date object>
 * }
 * @param result string (JUnit XML typically)
 * @param cb callback (err) err or null
 */

CassandraBackend.prototype.addResult = function (test, commit, result, cb) {
    //This is under the assumption that we only add the results from the most recent commit
    this.latestRevision.commit = commit;
    this.removePassedTest(test);

    var cql = 'insert into results (test, tid, result) values (?, ?, ?);';
    args = [test, tidFromDate(this.commits[0].timestamp), result];
    this.client.execute(cql, args, this.consistencies.write, function (err, result) {
        if (err) {
            console.log(err);
        } else {}
    });

    var skipCount = (result.match( /<skipped/g ) || []).length,
        failCount = (result.match( /<failure/g ) || []).length,
        errorCount = (result.match( /<error/g ) || []).length,
        skips, counts;

    var score = statsScore(skipCount, failCount, errorCount);
    cql = 'UPDATE revision_summary SET skipstats = ?, failstats = ? WHERE revision = ?';

    //Update latest results array
    if (this.commits.length > 1 && this.testScores[test.toString()] != score ) {
        counts = countScore(score);
        skips = this.latestResults[commit.toString()].skips;
        fails = this.latestResults[commit.toString()].fails;

        if (!skips[counts.skips]) {
            skips[counts.skips] = 1;
        } else {
            skips[counts.skips] += 1;
        }
        if (!fails[counts.fails]) {
            fails[counts.fails] = 1;
        } else {
            fails[counts.fails]++;
        }
        this.latestResults[commit.toString()].skips = skips;
        this.latestResults[commit.toString()].fails = fails;

        args = {value: skips, hint: 'map'};
        args2 = {value: fails, hint: 'map'};
        this.client.execute(cql, [args, args2, commit], this.consistencies.write, function (err, result) {
            if (err) {
                console.log(err);
            }
        });

    } else {

        counts = countScore(score);
        skips = this.latestResults[commit.toString()].skips;
        fails = this.latestResults[commit.toString()].fails;

        // update stats
        if (!skips) {
            skips = [];
        }
        if (!fails) {
            fails = [];
        }
        if (!skips[counts.skips]) {
            skips[counts.skips] = 1;
        } else {
            skips[counts.skips] += 1;
        }
        if (!fails[counts.fails]) {
            fails[counts.fails] = 1;
        } else {
            fails[counts.fails]++;
        }
        this.latestResults[commit.toString()].skips = skips;
        this.latestResults[commit.toString()].fails = fails;

        // update db with stats
        args =  {value: skips, hint: 'map'};
        args2 =  {value: fails, hint: 'map'};
        this.client.execute(cql, [args, args2, commit] , this.consistencies.write, function (err, result) {
            if (err) {
                console.log(err);
            }
        });
    }

    // Check if test score changed
    if (this.testScores[test.toString()] != score) {
        // If changed, update test_by_score
        cql = 'insert into test_by_score (commit, score, delta, test) values (?, ?, ?, ?);';
        // args = [commit, score, this.testScores[test] - score, test];
        args = [commit, score, 0, test];

        this.client.execute(cql, args, this.consistencies.write, function(err, result) {
            if (err) {
                console.log(err);
            } else {
            }
        });
        // Update scores in memory;
        this.testScores[test.toString()] = score;
    }

    // Update topFails
    var index = findWithAttr(this.topFailsArray, "test", test);
    if (index != -1 && this.topFailsArray[index].score <= score) {
        this.topFailsArray[index].score = score;
        this.topFailsArray[index].commit = commit;
       // console.log("updated score");
        this.topFailsArray.sort(function(a, b) { return b.score - a.score;} );
    }
};

var statsScore = function (skipCount, failCount, errorCount) {
    // treat <errors,fails,skips> as digits in a base 1000 system
    // and use the number as a score which can help sort in topfails.
    return errorCount * 1000000 + failCount * 1000 + skipCount;
};

var countScore = function(score) {
    var skipsCount = score % 1000;
    score = score - skipsCount;
    var failsCount = (score % 1000000) / 1000;
    score = score - failsCount * 1000;
    var errorsCount = score / 1000000;

    return {skips: skipsCount, fails: failsCount, errors: errorsCount}
};

/**
 * Get results ordered by score
 *
 * @param offset (for pagination)
 * @param limit  (for pagination)
 * @param cb
 *
 */
CassandraBackend.prototype.getTopFails = function (offset, limit, cb) {

    /**
     * cb
     *
     * @param results array [
     *    object {
     *      commit: <commit hash>,
     *      test: <test blob>,
     *      skips:  <skip count>,
     *      fails:  <fails count>,
     *      errors: <errors count>
     *      }
     * ]
     */

    var results = [];
    for (var i = offset; i < limit + offset; i++) {
        if (!this.topFailsArray[i]) {
            break;
        }
        var current = this.topFailsArray[i];
        var score = current.score;

        // console.log("score:" );
        // console.log(score);
        var counts = countScore(score);

        // console.log("errors: " + errorsCount);
        // console.log("fails: " + failsCount);
        // console.log("skips: " + skipsCount);
        var result = {
            commit: current.commit, test: current.test, skips: counts.skips,
            fails: counts.fails, errors: counts.errors
        };
        results.push(result);
    }
    cb(results);
};

CassandraBackend.prototype.getFailsDistr = function(cb) {

    var args = [], results = {}, fails;

    if (!this.commits.length) {
        cb(null, { fails: {}});
    } else {
        commit = this.commits[0].hash.toString();
        fails = this.latestResults[commit].fails;
        results = { fails: fails };
    }
    cb(null, results);

};

CassandraBackend.prototype.getSkipsDistr = function(cb) {
    var args = [], results = {}, skips;
    if (!this.commits.length) {
        cb(null, { skips: {}});
    } else {
        commit = this.commits[0].hash.toString();
        skips = this.latestResults[commit].skips;
        results = { skips: skips };
    }
    cb(null, results);

};



var regressionsHeaderData = ['Title', 'New Commit', 'Errors|Fails|Skips', 'Old Commit', 'Errors|Fails|Skips'];


//errorCount * 1000000 + failCount * 1000 + skipCount;

var regressionHelper = function(test, score1, score2) {

  var res = {
    test: test,
    score1: score1,
    score2: score2,
    errors: 0,
    fails: 0,
    skips: 0,
    old_errors: 0,
    old_fails: 0,
    old_skips: 0
  }

  if(score1 >= 1000000) {
    res.errors = Math.floor(score1 / 1000000);
    score1 = score1 - (1000000 * res.errors);
  }
  if(score2 >= 1000000) {
    res.old_errors = Math.floor(score2 / 1000000);
    score2 = score2 - (1000000 * res.old_errors);
  }

  if(score1 >= 1000) {
    res.fails = Math.floor(score1 /1000);
    score1 = score1- (1000 * res.fails);
  }
  if(score2 >= 1000) {
    res.old_fails = Math.floor(score2 / 1000);
    score2 = score2- (1000 * res.old_fails);
  }

  if(score1 > 0) {
    res.skips = score1;
  }
  if(score2 > 0) {
    res.old_skips = score2;
  }

  return res;
}
/**
This method calculates all the scores data from the tests table
**/
function calcRegressionFixes(r1, r2, cb) {
    //var data = mock.testdata;

    //if r1 is the latest revision

    //select all the test_by_scores from r1, and for each of them, select all of the scores from r2 (if exists)
    //
    //console.log("this.latest: " + this.latestRevision);
    var regData = [];
    var fixData = [];

    var queries = [{
        query: 'select test, score from test_by_score where commit = ?',
        params: [new Buffer(r1)]
    }, {
        query: 'select test, score from test_by_score where commit = ?',
        params: [new Buffer(r2)]
    }];

    var firstResults = {};
    var queryCB = function (err, results) {
        if (err) {
            cb(err);
        } else if (!results || !results.rows || results.rows.length === 0) {
            //console.log( 'no seen commits, error in database' );
            cb("no seen commits, error in database");
        } else {
            firstResults = results.rows;
            this.client.execute(queries[1].query, queries[1].params, this.consistencies.write, queryCB2.bind(this));
        }
    };
    var queryCB2 = function (err, results) {
        if (err) {
            cb(err);
        } else if (!results || !results.rows || results.rows.length === 0) {
            //console.log( 'no seen commits, error in database' );
            cb("no seen commits, error in database");
        } else {
            var data = results.rows;
            //console.log("results: " + JSON.stringify(results, null, '\t'));
            //go through firstResults, and for each of its tests find the corresponding one
            //in the results rows, and for each of them that are regressions, push it to the regData, else fixData
            for(var y in firstResults) {
                //console.log("result: " + firstResults[y][0].toString());
                for(var x in data) {
                    if(data[x]['test'].toString() === firstResults[y]['test'].toString()) {
                      // var ret = {
                      //     first: firstResults[y],
                      //     second: data[x]
                      // };
                      // console.log("ret: " + JSON.stringify(ret, null,'\t'));
                      var score1 = firstResults[y]['score'];
                      var score2 = data[x]['score'];
                      var test = data[x]['test'].toString();
                      if(score1< score2) fixData.push(regressionHelper(test, score1, score2));
                      else if (score1 > score2) regData.push(regressionHelper(test, score1, score2));
                    }
                }
                //console.log("y: " + JSON.stringify(firstResults[y],null, '\t'))
            }
            cb(null, regData, fixData);
        }
    };

    this.client.execute(queries[0].query, queries[0].params, this.consistencies.write, queryCB.bind(this));
    // for(var y in data) {
    //   var x = data[y];
    //   var newtest = statsScore(x.skips, x.fails, x.errors);
    //   var oldtest = statsScore(x.old_skips, x.old_fails, x.old_errors);

    //   /*if they differ then we're going to push it in either the regression or fixes*/
    //   if(newtest !== oldtest)  {
    //     /*if the new is better than the old then it's a fix, otherwise regress*/
    //     (newtest < oldtest) ?fixData.push(x) : regData.push(x);
    //   }
    // }

    // //console.log("data: " + JSON.stringify(resgData, null, '\t') + "\n" + JSON.stringify(fixData,null,'\t'));
    // cb (null, regData, fixData);


}

CassandraBackend.prototype.getRegressions = function (r1, r2, prefix, page, cb) {
    var calc = calcRegressionFixes.bind(this);
    calc(r1, r2, function (err, reg, fix) {
        if (err) return cb(err);
        //return console.log("regressions: " +JSON.stringify(regressions,null,'\t'));
        async.sortBy(reg, function(item, callback) {
            callback(null, item.score2 - item.score1);
        }, function(err, regressions) {
            var mydata = {
                page: page,
                urlPrefix: prefix,
                urlSuffix: '',
                heading: "Total regressions between selected revisions: " + regressions.length,
                /*change this with mock's num regresssions*/
                headingLink: {
                    url: "/topfixes/between/" + r1 + "/" + r2,
                    name: 'topfixes'
                },
                header: regressionsHeaderData
            };

            for (var i = 0; i < regressions.length; i++) {
                regressions[i].old_commit = r2;
                regressions[i].new_commit = r1;
            }


            //console.log("json: " + JSON.stringify(regressions, null, '\t'));

            cb(null, regressions, mydata);
    });
    });
}

/**
 * getRegressionRows mock method returns the mock data of the fake regressions
 */
CassandraBackend.prototype.getFixes = function (r1, r2, prefix, page, cb) {
    var calc = calcRegressionFixes.bind(this);
    calc(r1, r2, function (err, reg, fix) {
        if(err) return cb(err);

        async.sortBy(fix, function(item, callback) {
            callback(null, item.score1 - item.score2);
        }, function(err, fixes) {
            var mydata = {
                page: page,
                urlPrefix: prefix,
                urlSuffix: '',
                heading: "Total fixes between selected revisions: " + fixes.length,
                /*change this with mock's num regresssions*/
                headingLink: {
                    url: '/regressions/between/' + r1 + '/' + r2,
                    name: 'regressions'
                },
                header: regressionsHeaderData
            };

            for (var i = 0; i < fixes.length; i++) {
                fixes[i].old_commit = r2;
                fixes[i].new_commit = r1;
            }
            cb(null, fixes, mydata);
        });
    });
};

/*
This function returns the last 2commits
if there's only one commit, it only returns one
*/
var returnLatestCommit = function(cb) {
    if(!this.commits || this.commits.length === 0)  {
        cb("no commits found");
    } else {
        if(this.commits.length === 1) {
            cb(null, this.commits[0].hash);
        } else {
            cb( null, this.commits[0].hash, this.commits[1].hash);
        }
    }
};
// Node.js module exports. This defines what
// require('./CassandraBackend.js'); evaluates to.
module.exports = CassandraBackend;
