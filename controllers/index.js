'use strict';

const _ = require('lodash');
const moment = require('moment');

const prAmount = 5;

const statements = [
    'It\'s not too late to start!',
    'Off to a great start, keep going!',
    'Keep it up!',
    'Nice! Now, don\'t stop!',
    'So close!',
    'Way to go!',
    'Now you\'re just showing off!'
];

const errors = {
    notUser: 'Username must belong to a user account.'
};

const errorCodes = {
    notUser: 400
};


/**
 * GET /
 */
exports.index = (req, res) => {
    const github = req.app.get('github');
    const username = req.query.username;
    const statsLink = '/me';

    var hostname = `${req.protocol}://${req.headers.host}`;
    var today = new Date();
    var curmonth = today.getMonth();
    var timeleft = 31 - today.getDate();
    var timemessage = '';
    if (curmonth === 9) {
        if (timeleft === 0) {
            timemessage = 'It\'s the very last day! Get your last PRs in!';
        } else if (timeleft === 1) {
            timemessage = 'One more day, keep it going!';
        } else if (timeleft < 10) {
            timemessage = 'There\'s only ' + timeleft + ' days left! You can do it!';
        } else {
            timemessage = 'There\'s ' + timeleft + ' days remaining!';
        }
    }

    // in a reverse proxy situation we have to use the referer to retrieve
    // the correct protocol, hostname, and path
    // unfortunately this won't work, when accessng the page directly:
    // e.g.: http://example.com/hacktoberfest/?username=XXX
    // in such a case we set hostname to an empty string and create the link
    // with js after the page has loaded
    if (req.headers['x-forwarded-for']) {
        const referer = req.headers.referer;
        if (referer) {
            hostname = referer.split('?')[0].slice(0, -1);
            if (hostname.endsWith(statsLink.slice(0, -1))) {
                hostname = hostname.slice(0, -1*(statsLink.slice(0, -1).length));
            }
        } else {
            hostname = '';
        }
    }

    if (!username) {
        if (req.xhr) {
            return res.render('partials/error', {hostname: hostname, layout: false});
        }

        return res.render('index', {hostname: hostname, timemessage: timemessage});
    }
    function getStatement(prs) {
        if (curmonth < 9) {
            return 'Last year\'s result.';
        } else if (curmonth === 9) {
            return statements[prs.length < prAmount+1 ? prs.length : prAmount+1 ];
        } else {
            return 'This year\'s result.';
        }
    }

    Promise.all([
        findPrs(github, username),
        github.users.getForUser({username})
            .then(logCallsRemaining)
    ])
        .then(([prs, user]) => {
            if (user.data.type !== 'User') {
                return Promise.reject('notUser');
            }

            const data = {
                prs,
                isNotComplete: prs.length < prAmount,
                statement: getStatement(prs),
                username,
                userImage: user.data.avatar_url,
                hostname: hostname,
                prAmount
            };

            if (req.query['plain-data']) {
                res.render('partials/prs', _.assign(data, {layout: false}));
            } else {
                res.render('index', data);
            }
        }).catch((err) => {
            console.log(err);
            if (req.xhr) {
                const code = errorCodes[err] || 404;
                res.status(code).render('partials/error', {
                    hostname: hostname,
                    layout: false,
                    errorMsg: errors[err]
                });
            } else {
                res.render('index', {
                    hostname: hostname,
                    error: true,
                    errorMsg: errors[err],
                    username
                });
            }
        });
};


let pullRequestData = [];

function getNextPage(response, github) {
    const promise = new Promise(function(resolve, reject) {
        github.getNextPage(response, function(err, res) {
            if (err) {
                reject();
                return false;
            }

            pullRequestData = pullRequestData.concat(res['data'].items);
            if (github.hasNextPage(res)) {
                getNextPage(res, github).then(function () {
                    resolve();
                });
            } else {
                if (process.env.NODE_ENV !== 'production') {
                    console.log('Found ' + pullRequestData.length + ' pull requests.');
                }
                resolve();
            }
        });
    });
    return promise;
}

function loadPrs(github, username) {
    const promise = new Promise(function(resolve, reject) {
        var today = new Date();
        var curmonth = today.getMonth();
        var curyear = today.getFullYear();
        var searchyear = curyear;
        if (curmonth < 9) {
            searchyear = curyear - 1;
        }
        github.search.issues({
            q: `-label:invalid+created:${searchyear}-09-30T00:00:00-12:00..${searchyear}-10-31T23:59:59-12:00+type:pr+is:public+author:${username}`,
            per_page: 100  // 30 is the default but this makes it clearer/allows it to be tweaked
        }, function(err, res) {
            if (err) {
                reject();
                return false;
            }

            pullRequestData = pullRequestData.concat(res['data'].items);
            if (github.hasNextPage(res)) {
                getNextPage(res, github).then(function () {
                    resolve();
                });
            } else {
                if (process.env.NODE_ENV !== 'production') {
                    console.log('Found ' + pullRequestData.length + ' pull requests.');
                }
                resolve();
            }
        });
    });

    return promise;
}

function findPrs(github, username) {
    pullRequestData = [];
    return loadPrs(github, username, pullRequestData)
        .then(function() {
            pullRequestData = _.map(pullRequestData, event => {
                const repo = event.pull_request.html_url.substring(0, event.pull_request.html_url.search('/pull/'));
                const hacktoberFestLabels = _.some(event.labels, label => label.name.toLowerCase() === 'hacktoberfest');

                return {
                    has_hacktoberfest_label: hacktoberFestLabels,
                    number: event.number,
                    open: event.state === 'open',
                    repo_name: repo.replace('https://github.com/', ''),
                    title: event.title,
                    url: event.html_url,
                    created_at: moment(event.created_at).format('MMMM Do YYYY'),
                    user: {
                        login: event.user.login,
                        url: event.user.html_url
                    },
                };
            });
            return Promise.resolve(pullRequestData);
        }).then(prs => {
            const checkMergeStatus = _.map(prs, pr => {
                const repoDetails = pr.repo_name.split('/');
                const pullDetails = {
                    owner: repoDetails[0],
                    repo: repoDetails[1],
                    number: pr.number
                };

                return github.pullRequests.checkMerged(pullDetails)
                    .then(logCallsRemaining)
                    .then(res => res.meta.status === '204 No Content')
                    .catch(err => {
                        // 404 means there wasn't a merge
                        if (err.code === 404) {
                            return false;
                        }

                        throw err;
                    });
            });

            return Promise
                .all(checkMergeStatus)
                .then(mergeStatus => Promise.resolve(_.zipWith(prs, mergeStatus, (pr, merged) => _.assign(pr, {merged}))));
        });
}

const logCallsRemaining = res => {
    var callsRemaining = res.meta['x-ratelimit-remaining'];
    if (process.env.NODE_ENV !== 'production') {
        console.log('API calls remaining: ' + callsRemaining);
    } else if (callsRemaining < 100) {
        console.log('API calls remaining: ' + callsRemaining);
    }
    return res;
};

exports.me = (req, res) => {
    var hostname = `${req.protocol}://${req.headers.host}`;
    res.render('me', {hostname: hostname});
};

exports.notfound = (req, res) => {
    var hostname = `${req.protocol}://${req.headers.host}`;
    res.render('404', {hostname: hostname});
};
