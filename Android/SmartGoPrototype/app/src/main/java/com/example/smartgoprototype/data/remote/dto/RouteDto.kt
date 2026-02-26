package com.example.smartgoprototype.data.remote.dto

import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.squareup.moshi.Json
import java.time.DayOfWeek
import java.time.ZoneId

data class RouteDto(
    @field:Json(name = "id") val id: String,
    @field:Json(name = "title") val title: String,
    @field:Json(name = "origin") val origin: String,
    @field:Json(name = "destination") val destination: String
)

data class CreateRouteRequest(
    @field:Json(name = "title") val title: String,
    @field:Json(name = "origin") val origin: String,
    @field:Json(name = "destination") val destination: String
)

fun RouteDto.toDomain(): Route =
    Route(
        id = id,
        title = title,
        origin = PlaceLocation(
            placeId = "legacy-origin",
            name = null,
            address = origin,
            lat = null,
            lng = null
        ),
        destination = PlaceLocation(
            placeId = "legacy-destination",
            name = null,
            address = destination,
            lat = null,
            lng = null
        ),
        schedule = RouteSchedule(
            arriveByMinutes = 9 * 60,
            activeDays = setOf(
                DayOfWeek.MONDAY,
                DayOfWeek.TUESDAY,
                DayOfWeek.WEDNESDAY,
                DayOfWeek.THURSDAY,
                DayOfWeek.FRIDAY
            ),
            timeZoneId = ZoneId.systemDefault().id
        )
    )