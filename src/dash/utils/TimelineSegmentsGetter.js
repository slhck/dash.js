/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import FactoryMaker from '../../core/FactoryMaker';
import Constants from '../../streaming/constants/Constants';

import {getTimeBasedSegment} from './SegmentsUtils';

function TimelineSegmentsGetter(config, isDynamic) {

    config = config || {};
    const timelineConverter = config.timelineConverter;

    let instance;

    function checkConfig() {
        if (!timelineConverter || !timelineConverter.hasOwnProperty('calcMediaTimeFromPresentationTime') ||
            !timelineConverter.hasOwnProperty('calcSegmentAvailabilityRange')) {
            throw new Error(Constants.MISSING_CONFIG_ERROR);
        }
    }

    function getSegmentsFromTimeline(representation, requestedTime, index, availabilityUpperLimit) {
        checkConfig();

        if (!representation) {
            throw new Error('no representation');
        }

        if (requestedTime === undefined) {
            requestedTime = null;
        }

        const base = representation.adaptation.period.mpd.manifest.Period_asArray[representation.adaptation.period.index].
            AdaptationSet_asArray[representation.adaptation.index].Representation_asArray[representation.index].SegmentTemplate ||
            representation.adaptation.period.mpd.manifest.Period_asArray[representation.adaptation.period.index].
            AdaptationSet_asArray[representation.adaptation.index].Representation_asArray[representation.index].SegmentList;
        const timeline = base.SegmentTimeline;
        const list = base.SegmentURL_asArray;
        const isAvailableSegmentNumberCalculated = representation.availableSegmentsNumber > 0;

        let maxSegmentsAhead;

        if (availabilityUpperLimit) {
            maxSegmentsAhead = availabilityUpperLimit;
        } else {
            maxSegmentsAhead = (index > -1 || requestedTime !== null) ? 10 : Infinity;
        }

        let time = 0;
        let scaledTime = 0;
        let availabilityIdx = -1;
        const segments = [];
        let requiredMediaTime = null;

        let fragments,
            frag,
            i,
            len,
            j,
            repeat,
            repeatEndTime,
            nextFrag,
            hasEnoughSegments,
            startIdx,
            fTimescale;

        let createSegment = function (s, i) {
            let media = base.media;
            let mediaRange = s.mediaRange;

            if (list) {
                media = list[i].media || '';
                mediaRange = list[i].mediaRange;
            }

            return getTimeBasedSegment(
                timelineConverter,
                isDynamic,
                representation,
                time,
                s.d,
                fTimescale,
                media,
                mediaRange,
                availabilityIdx,
                s.tManifest);
        };

        fTimescale = representation.timescale;

        fragments = timeline.S_asArray;

        startIdx = index;

        if (requestedTime !== null) {
            requiredMediaTime = timelineConverter.calcMediaTimeFromPresentationTime(requestedTime, representation);
        }

        for (i = 0, len = fragments.length; i < len; i++) {
            frag = fragments[i];
            repeat = 0;
            if (frag.hasOwnProperty('r')) {
                repeat = frag.r;
            }

            // For a repeated S element, t belongs only to the first segment
            if (frag.hasOwnProperty('t')) {
                time = frag.t;
                scaledTime = time / fTimescale;
            }

            // This is a special case: "A negative value of the @r attribute of the S element indicates that the duration indicated in @d attribute repeats until the start of the next S element, the end of the Period or until the
            // next MPD update."
            if (repeat < 0) {
                nextFrag = fragments[i + 1];

                if (nextFrag && nextFrag.hasOwnProperty('t')) {
                    repeatEndTime = nextFrag.t / fTimescale;
                } else {
                    const availabilityEnd = representation.segmentAvailabilityRange ? representation.segmentAvailabilityRange.end : (timelineConverter.calcSegmentAvailabilityRange(representation, isDynamic).end);
                    repeatEndTime = timelineConverter.calcMediaTimeFromPresentationTime(availabilityEnd, representation);
                    representation.segmentDuration = frag.d / fTimescale;
                }

                repeat = Math.ceil((repeatEndTime - scaledTime) / (frag.d / fTimescale)) - 1;
            }

            // if we have enough segments in the list, but we have not calculated the total number of the segments yet we
            // should continue the loop and calc the number. Once it is calculated, we can break the loop.
            if (hasEnoughSegments) {
                if (isAvailableSegmentNumberCalculated) break;
                availabilityIdx += repeat + 1;
                continue;
            }

            for (j = 0; j <= repeat; j++) {
                availabilityIdx++;

                if (segments.length > maxSegmentsAhead) {
                    hasEnoughSegments = true;
                    if (isAvailableSegmentNumberCalculated) break;
                    continue;
                }

                if (requiredMediaTime !== null) {
                    // In some cases when requiredMediaTime = actual end time of the last segment
                    // it is possible that this time a bit exceeds the declared end time of the last segment.
                    // in this case we still need to include the last segment in the segment list. to do this we
                    // use a correction factor = 1.5. This number is used because the largest possible deviation is
                    // is 50% of segment duration.
                    if (scaledTime >= (requiredMediaTime - (frag.d / fTimescale) * 1.5)) {
                        segments.push(createSegment(frag, availabilityIdx));
                    }
                } else if (availabilityIdx >= startIdx) {
                    segments.push(createSegment(frag, availabilityIdx));
                }

                time += frag.d;
                scaledTime = time / fTimescale;
            }
        }

        if (!isAvailableSegmentNumberCalculated) {
            representation.availableSegmentsNumber = availabilityIdx + 1;
        }

        return segments;
    }

    instance = {
        getSegments: getSegmentsFromTimeline
    };

    return instance;
}

TimelineSegmentsGetter.__dashjs_factory_name = 'TimelineSegmentsGetter';
const factory = FactoryMaker.getClassFactory(TimelineSegmentsGetter);
export default factory;
