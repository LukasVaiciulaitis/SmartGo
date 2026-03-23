package com.example.smartgoprototype.data.local.entity

import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.model.TravelMode
import java.time.DayOfWeek

private val DAY_CODE_MAP = mapOf(
    "MON" to DayOfWeek.MONDAY,
    "TUE" to DayOfWeek.TUESDAY,
    "WED" to DayOfWeek.WEDNESDAY,
    "THU" to DayOfWeek.THURSDAY,
    "FRI" to DayOfWeek.FRIDAY,
    "SAT" to DayOfWeek.SATURDAY,
    "SUN" to DayOfWeek.SUNDAY
)

private val DAY_ORDER = listOf(
    DayOfWeek.MONDAY, DayOfWeek.TUESDAY, DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY, DayOfWeek.FRIDAY, DayOfWeek.SATURDAY, DayOfWeek.SUNDAY
)

fun String.toDomainDays(): Set<DayOfWeek> =
    split(",").mapNotNull { DAY_CODE_MAP[it.trim()] }.toSet()

fun Set<DayOfWeek>.toActiveDaysJson(): String =
    DAY_ORDER.filter { contains(it) }.joinToString(",") { it.name.take(3) }

fun RouteEntity.toDomain(): Route = Route(
    id = id,
    title = title,
    origin = PlaceLocation(placeId = originPlaceId, label = originLabel),
    destination = PlaceLocation(placeId = destinationPlaceId, label = destinationLabel),
    travelMode = TravelMode.valueOf(travelMode),
    userActive = userActive,
    schedule = RouteSchedule(
        arriveByMinutes = arriveByMinutes,
        activeDays = activeDaysJson.toDomainDays(),
        timeZoneId = timeZoneId
    )
)

fun Route.toEntity(): RouteEntity = RouteEntity(
    id = id,
    title = title,
    travelMode = travelMode.name,
    userActive = userActive,
    arriveByMinutes = schedule.arriveByMinutes,
    activeDaysJson = schedule.activeDays.toActiveDaysJson(),
    timeZoneId = schedule.timeZoneId,
    originPlaceId = origin.placeId,
    originLabel = origin.label,
    destinationPlaceId = destination.placeId,
    destinationLabel = destination.label,
    cachedAt = System.currentTimeMillis()
)
