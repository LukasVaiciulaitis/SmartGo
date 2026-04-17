package com.example.smartgoprototype.ui.editroute

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.model.TravelMode
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.LocalTime
import java.time.ZoneId
import javax.inject.Inject

@HiltViewModel
class EditRouteViewModel @Inject constructor(
    private val routeRepository: RouteRepository,
    savedStateHandle: SavedStateHandle
) : ViewModel() {

    private val routeId: String = checkNotNull(savedStateHandle["routeId"])

    private val _uiState = MutableStateFlow(EditRouteUiState())
    val uiState: StateFlow<EditRouteUiState> = _uiState

    // Snapshots taken at load time — used to detect what actually changed before sending to the backend.
    private var originalTravelMode: TravelMode? = null
    private var originalArriveBy: LocalTime? = null
    private var originalActiveDays: Set<DayOfWeek>? = null

    init { loadRoute() }

    private fun loadRoute() {
        viewModelScope.launch {
            runCatching { routeRepository.getRouteById(routeId) }
                .onSuccess { route ->
                    if (route != null) {
                        val arriveBy = LocalTime.of(route.schedule.arriveByMinutes / 60, route.schedule.arriveByMinutes % 60)
                        originalTravelMode = route.travelMode
                        originalArriveBy = arriveBy
                        originalActiveDays = route.schedule.activeDays
                        _uiState.value = EditRouteUiState(
                            routeId = route.id,
                            title = route.title,
                            originLabel = route.origin.label,
                            destinationLabel = route.destination.label,
                            travelMode = route.travelMode,
                            arriveBy = arriveBy,
                            activeDays = route.schedule.activeDays,
                            isLoading = false
                        )
                    } else {
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            errorMessage = "Route not found"
                        )
                    }
                }
                .onFailure { e ->
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        errorMessage = e.message ?: "Failed to load route"
                    )
                }
        }
    }

    fun onTitleChange(value: String) {
        _uiState.value = _uiState.value.copy(title = value, errorMessage = null)
    }

    fun onTravelModeSelected(mode: TravelMode) {
        _uiState.value = _uiState.value.copy(travelMode = mode, errorMessage = null)
    }

    fun onArriveByChange(hour: Int, minute: Int) {
        _uiState.value = _uiState.value.copy(
            arriveBy = _uiState.value.arriveBy.withHour(hour).withMinute(minute),
            errorMessage = null
        )
    }

    fun toggleDay(day: DayOfWeek) {
        val days = _uiState.value.activeDays
        _uiState.value = _uiState.value.copy(
            activeDays = if (days.contains(day)) days - day else days + day,
            errorMessage = null
        )
    }

    fun save(onSaved: () -> Unit) {
        val state = _uiState.value
        if (!state.canSave) return

        _uiState.value = state.copy(isSaving = true, errorMessage = null)

        val travelModeChanged = state.travelMode != originalTravelMode
        val scheduleChanged = state.arriveBy != originalArriveBy || state.activeDays != originalActiveDays

        viewModelScope.launch {
            runCatching {
                routeRepository.updateRoute(
                    routeId = state.routeId,
                    title = state.title.trim(),
                    travelMode = if (travelModeChanged || scheduleChanged) state.travelMode else null,
                    arriveByMinutes = if (scheduleChanged) state.arriveBy.hour * 60 + state.arriveBy.minute else null,
                    timezone = if (scheduleChanged) ZoneId.systemDefault().id else null,
                    activeDays = if (scheduleChanged) state.activeDays else null
                )
            }.onSuccess {
                _uiState.value = _uiState.value.copy(isSaving = false)
                onSaved()
            }.onFailure { e ->
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    errorMessage = e.message ?: "Failed to save route"
                )
            }
        }
    }
}
