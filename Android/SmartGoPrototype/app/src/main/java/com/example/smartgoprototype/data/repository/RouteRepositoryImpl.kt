package com.example.smartgoprototype.data.repository

import com.example.smartgoprototype.data.local.dao.RouteDao
import com.example.smartgoprototype.data.local.entity.RouteEntity
import com.example.smartgoprototype.data.local.entity.toActiveDaysJson
import com.example.smartgoprototype.data.local.entity.toDomain
import com.example.smartgoprototype.data.local.entity.toEntity
import com.example.smartgoprototype.data.remote.api.RoutesApi
import com.example.smartgoprototype.data.remote.dto.CreateRouteRequest
import com.example.smartgoprototype.data.remote.dto.DeleteRouteRequestDto
import com.example.smartgoprototype.data.remote.dto.EndpointPlace
import com.example.smartgoprototype.data.remote.dto.FetchedRouteDto
import com.example.smartgoprototype.data.remote.dto.ForecastDto
import com.example.smartgoprototype.data.remote.dto.GoogleAddressComponentDto
import com.example.smartgoprototype.data.remote.dto.IntermediatePlace
import com.example.smartgoprototype.data.remote.dto.RouteCreatedDto
import com.example.smartgoprototype.data.remote.dto.UpdateRouteRequestDto
import com.example.smartgoprototype.domain.model.ForecastDay
import com.example.smartgoprototype.domain.model.ForecastRecommendation
import com.example.smartgoprototype.domain.model.ForecastStatus
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteForecast
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.model.TravelMode
import com.example.smartgoprototype.domain.repository.RouteRepository
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import java.io.IOException
import java.time.DayOfWeek
import javax.inject.Inject
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONObject
import retrofit2.HttpException

/**
 * Offline-first implementation of [RouteRepository].
 *
 * Room is the single source of truth. All reads go through the local cache via [observeRoutes].
 * Network calls write their results back to Room, which propagates changes reactively to the UI.
 *
 * Optimistic writes: mutating operations update Room immediately before the network call. On
 * network failure the old entity is restored and the exception is re-thrown for the ViewModel
 * to surface as an error.
 */
class RouteRepositoryImpl @Inject constructor(
    private val api: RoutesApi,
    private val dao: RouteDao,
    private val moshi: Moshi
) : RouteRepository {

    private val forecastAdapter by lazy {
        moshi.adapter(RouteForecast::class.java)
    }

    private fun deserializeForecast(json: String?): RouteForecast? =
        json?.let { runCatching { forecastAdapter.fromJson(it) }.getOrNull() }

    private fun serializeForecast(forecast: RouteForecast?): String? =
        forecast?.let { runCatching { forecastAdapter.toJson(it) }.getOrNull() }

    override fun observeRoutes(): Flow<List<Route>> =
        dao.observeRoutes().map { entities ->
            entities.map { entity ->
                entity.toDomain(parsedForecast = deserializeForecast(entity.forecastJson))
            }
        }

    override suspend fun refreshRoutes() {
        val response = executeApiCall { api.getRoutes() }

        val existingSortOrders = dao.getAll().associate { it.id to it.sortOrder }
        var nextOrder = (existingSortOrders.values.maxOrNull() ?: -1) + 1

        val entities = response.routes.map { dto ->
            dto.toEntity().copy(
                sortOrder = existingSortOrders[dto.routeId] ?: nextOrder++
            )
        }
        dao.replaceAll(entities)
    }

    override suspend fun getRouteById(routeId: String): Route? =
        dao.getById(routeId)?.let { entity ->
            entity.toDomain(parsedForecast = deserializeForecast(entity.forecastJson))
        }

    override suspend fun addRoute(
        title: String,
        origin: PlaceLocation,
        destination: PlaceLocation,
        intermediates: List<PlaceLocation>,
        travelMode: TravelMode,
        schedule: RouteSchedule
    ): Route {
        val request = CreateRouteRequest(
            title = title.trim(),
            origin = origin.toEndpointPlace(requireComponents = true),
            destination = destination.toEndpointPlace(requireComponents = true),
            intermediates = intermediates.map { it.toIntermediate() }.ifEmpty { emptyList() },
            travelMode = travelMode.name,
            arriveBy = schedule.arriveByMinutes.toArriveByHHmm(),
            timezone = schedule.timeZoneId,
            daysOfWeek = schedule.activeDays.toBackendDays()
        )

        val response = executeApiCall { api.createRoute(request) }
        val route = response.route.toDomainRoute(fallbackSchedule = schedule, fallbackTravelMode = travelMode)
        dao.upsert(route.toEntity().copy(sortOrder = dao.nextSortOrder()))
        return route
    }

    override suspend fun updateRoute(
        routeId: String,
        title: String?,
        travelMode: TravelMode?,
        userActive: Boolean?,
        arriveByMinutes: Int?,
        timezone: String?,
        activeDays: Set<DayOfWeek>?
    ) {
        val old = dao.getById(routeId)

        if (old != null) {
            dao.upsert(
                old.copy(
                    title = title ?: old.title,
                    travelMode = travelMode?.name ?: old.travelMode,
                    userActive = userActive ?: old.userActive,
                    arriveByMinutes = arriveByMinutes ?: old.arriveByMinutes,
                    timeZoneId = timezone ?: old.timeZoneId,
                    activeDaysJson = activeDays?.toActiveDaysJson() ?: old.activeDaysJson
                )
            )
        }

        val request = UpdateRouteRequestDto(
            routeId = routeId,
            title = title?.trim(),
            travelMode = travelMode?.name,
            userActive = userActive,
            arriveBy = arriveByMinutes?.toArriveByHHmm(),
            timezone = timezone,
            daysOfWeek = activeDays?.toBackendDays()
        )

        try {
            executeApiCall { api.updateRoute(request) }
        } catch (e: Exception) {
            if (old != null) dao.upsert(old)
            throw e
        }
    }

    override suspend fun reorderRoutes(orderedIds: List<String>) {
        orderedIds.forEachIndexed { index, id ->
            dao.updateSortOrder(id, index)
        }
    }

    override suspend fun deleteRoute(routeId: String) {
        val old = dao.getById(routeId)
        dao.deleteById(routeId)

        try {
            executeApiCall { api.deleteRoute(DeleteRouteRequestDto(routeId = routeId)) }
        } catch (e: Exception) {
            if (old != null) dao.upsert(old)
            throw e
        }
    }

    // --- DTO mapping ---

    private fun FetchedRouteDto.toEntity(): RouteEntity {
        val schedule = schedule.toDomainScheduleOrNull() ?: RouteSchedule(
            arriveByMinutes = 9 * 60,
            activeDays = emptySet(),
            timeZoneId = "UTC"
        )
        val domainForecast = forecast?.toDomain()
        return Route(
            id = routeId,
            title = title,
            origin = PlaceLocation(placeId = origin.placeId, label = origin.label),
            destination = PlaceLocation(placeId = destination.placeId, label = destination.label),
            travelMode = travelMode.toDomainTravelMode() ?: TravelMode.DRIVE,
            userActive = userActive ?: true,
            schedule = schedule,
            staticDuration = staticDuration,
            forecastStatus = forecastStatus.toDomainForecastStatus(),
            forecast = domainForecast
        ).toEntity().copy(forecastJson = serializeForecast(domainForecast))
    }

    private fun RouteCreatedDto.toDomainRoute(
        fallbackSchedule: RouteSchedule,
        fallbackTravelMode: TravelMode
    ): Route {
        val mappedSchedule = schedule.toDomainScheduleOrNull() ?: fallbackSchedule
        return Route(
            id = routeId,
            title = title,
            origin = PlaceLocation(placeId = origin.placeId, label = origin.label),
            destination = PlaceLocation(placeId = destination.placeId, label = destination.label),
            travelMode = travelMode.toDomainTravelMode() ?: fallbackTravelMode,
            userActive = true,
            schedule = mappedSchedule,
            forecastStatus = ForecastStatus.PENDING
        )
    }

    private fun ForecastDto.toDomain(): RouteForecast = RouteForecast(
        days = days.mapValues { (_, day) ->
            ForecastDay(
                forecastDate = day.forecastDate,
                recommendation = ForecastRecommendation(
                    adjustedDepartBy = day.recommendation.adjustedDepartBy,
                    extraBufferMins = day.recommendation.extraBufferMins,
                    reasoning = day.recommendation.reasoning,
                    mlLo = day.recommendation.mlLo,
                    mlHi = day.recommendation.mlHi
                ),
                hasWeatherData = day.hasWeatherData,
                hasEventData = day.hasEventData,
                hasRoadworksData = day.hasRoadworksData,
                hasTransitData = day.hasTransitData,
                hasHolidayData = day.hasHolidayData
            )
        },
        generatedAt = generatedAt
    )

    private fun String?.toDomainTravelMode(): TravelMode? =
        TravelMode.entries.find { it.name == this }

    private fun String?.toDomainForecastStatus(): ForecastStatus = when (this) {
        "active" -> ForecastStatus.ACTIVE
        "pending" -> ForecastStatus.PENDING
        else -> ForecastStatus.EMPTY
    }

    private fun com.example.smartgoprototype.data.remote.dto.CreatedScheduleDto?.toDomainScheduleOrNull(): RouteSchedule? {
        val schedule = this ?: return null
        return RouteSchedule(
            arriveByMinutes = schedule.arriveBy.toMinutesSinceMidnightOrDefault(),
            activeDays = schedule.daysOfWeek.toDomainDays(),
            timeZoneId = schedule.timezone
        )
    }

    private fun String.toMinutesSinceMidnightOrDefault(): Int {
        val parts = split(":")
        if (parts.size != 2) return 9 * 60
        val hour = parts[0].toIntOrNull() ?: return 9 * 60
        val minute = parts[1].toIntOrNull() ?: return 9 * 60
        if (hour !in 0..23 || minute !in 0..59) return 9 * 60
        return hour * 60 + minute
    }

    private fun List<String>.toDomainDays(): Set<DayOfWeek> {
        val map = mapOf(
            "MON" to DayOfWeek.MONDAY, "TUE" to DayOfWeek.TUESDAY, "WED" to DayOfWeek.WEDNESDAY,
            "THU" to DayOfWeek.THURSDAY, "FRI" to DayOfWeek.FRIDAY,
            "SAT" to DayOfWeek.SATURDAY, "SUN" to DayOfWeek.SUNDAY
        )
        return mapNotNull { map[it] }.toSet()
    }

    // --- PlaceLocation helpers ---

    private fun PlaceLocation.toEndpointPlace(requireComponents: Boolean): EndpointPlace {
        val components = addressComponents
            .orEmpty()
            .mapNotNull { component ->
                val sanitizedTypes = component.types.filter { it.isNotBlank() }
                if (sanitizedTypes.isEmpty()) return@mapNotNull null
                component.copy(types = sanitizedTypes)
            }

        if (requireComponents && components.isEmpty()) {
            throw IllegalStateException("addressComponents missing or invalid for placeId=$placeId")
        }

        return EndpointPlace(
            placeId = placeId,
            label = label,
            addressComponents = components.map {
                GoogleAddressComponentDto(longText = it.longText, shortText = it.shortText, types = it.types)
            }
        )
    }

    private fun PlaceLocation.toIntermediate(): IntermediatePlace =
        IntermediatePlace(placeId = placeId, label = label)

    // --- Formatting helpers ---

    private fun Int.toArriveByHHmm(): String {
        val h = this / 60
        val m = this % 60
        return "%02d:%02d".format(h, m)
    }

    private fun Set<DayOfWeek>.toBackendDays(): List<String> {
        val order = listOf(
            DayOfWeek.MONDAY, DayOfWeek.TUESDAY, DayOfWeek.WEDNESDAY,
            DayOfWeek.THURSDAY, DayOfWeek.FRIDAY, DayOfWeek.SATURDAY, DayOfWeek.SUNDAY
        )
        return order.filter { contains(it) }.map { it.name.take(3) }
    }

    // --- Error handling ---

    private suspend fun <T> executeApiCall(block: suspend () -> T): T {
        return try {
            block()
        } catch (t: Throwable) {
            throw t.toRepositoryException()
        }
    }

    private fun Throwable.toRepositoryException(): Exception {
        return when (this) {
            is HttpException -> Exception(httpErrorMessage(), this)
            is IOException -> Exception("Network error. Please check your connection and try again.", this)
            else -> Exception(message ?: "Unexpected error", this)
        }
    }

    private fun HttpException.httpErrorMessage(): String {
        val code = code()
        val serverMessage = runCatching {
            response()?.errorBody()?.string()
                ?.let { JSONObject(it).optString("error") }
                ?.takeIf { it.isNotBlank() }
        }.getOrNull()

        if (!serverMessage.isNullOrBlank()) return serverMessage

        return when (code) {
            400 -> "Invalid request."
            401 -> "Unauthorised - please sign in again."
            422 -> "Route could not be processed"
            500 -> "Internal Server error. Please try again."
            503 -> "Routing service temporarily unavailable. Please try again."
            else -> "Request failed with HTTP $code."
        }
    }
}
